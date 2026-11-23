use super::policy::{self, error, MAX_SLOTS, PRIVATE_ROOT, UNVERIFIED};
use nuphylab_core::{
    output::Connection,
    recovery::{JournalStore, RecoveryStatus},
    Model, Result,
};
use std::{
    ffi::{c_void, OsString},
    fs::{self, File, OpenOptions},
    mem::size_of,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr,
    sync::Arc,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_INSUFFICIENT_BUFFER,
        HANDLE, RPC_E_CHANGED_MODE,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SE_FILE_OBJECT,
        },
        GetLengthSid, GetSecurityDescriptorControl, GetTokenInformation, IsValidAcl, IsValidSid,
        TokenUser, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
        TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateDirectoryW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
        READ_CONTROL,
    },
    System::{
        Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED},
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
    UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath},
};

const PATH_ERROR: &str = "RECOVERY_STORAGE_PATH";
const PERMISSIONS_ERROR: &str = "RECOVERY_STORAGE_PERMISSIONS";
fn path_error() -> nuphylab_core::BridgeError {
    error(PATH_ERROR, "无法安全打开恢复目录，请检查路径或目录占用")
}
fn permissions_error() -> nuphylab_core::BridgeError {
    error(
        PERMISSIONS_ERROR,
        "恢复目录的归属或私有权限不符合要求，原目录未修改",
    )
}
struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}
struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Com(bool);
impl Com {
    fn enter() -> Result<Self> {
        let result = unsafe { CoInitializeEx(ptr::null(), COINIT_MULTITHREADED as u32) };
        if result < 0 && result != RPC_E_CHANGED_MODE {
            return Err(path_error());
        }
        Ok(Self(result >= 0))
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                CoUninitialize();
            }
        }
    }
}
unsafe fn wide_string(pointer: *const u16) -> Result<Vec<u16>> {
    if pointer.is_null() {
        return Err(path_error());
    }
    for len in 0..32768 {
        if *pointer.add(len) == 0 {
            return Ok(std::slice::from_raw_parts(pointer, len).to_vec());
        }
    }
    Err(path_error())
}
fn known_folder() -> Result<PathBuf> {
    let _com = Com::enter()?;
    let mut pointer = ptr::null_mut();
    let result =
        unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, ptr::null_mut(), &mut pointer) };
    let path = if result >= 0 {
        unsafe { wide_string(pointer) }.map(|v| PathBuf::from(OsString::from_wide(&v)))
    } else {
        Err(path_error())
    };
    unsafe {
        CoTaskMemFree(pointer.cast());
    }
    path
}
struct Identity {
    sid: Vec<u8>,
    descriptor: LocalAllocation,
}
impl Identity {
    fn current() -> Result<Self> {
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(permissions_error());
        }
        let token = Token(token);
        let mut required = 0;
        let first =
            unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut required) };
        if first != 0
            || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
            || required < size_of::<TOKEN_USER>() as u32
            || required > 65536
        {
            return Err(permissions_error());
        }
        let mut words = vec![0usize; (required as usize).div_ceil(size_of::<usize>())];
        let capacity = words.len() * size_of::<usize>();
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                words.as_mut_ptr().cast(),
                capacity as u32,
                &mut required,
            )
        } == 0
            || required as usize > capacity
            || required < size_of::<TOKEN_USER>() as u32
        {
            return Err(permissions_error());
        }
        let user = unsafe { ptr::read_unaligned(words.as_ptr().cast::<TOKEN_USER>()) };
        let start = words.as_ptr() as usize;
        let sid_start = user.User.Sid as usize;
        if sid_start < start || sid_start.saturating_add(8) > start + required as usize {
            return Err(permissions_error());
        }
        let count = unsafe { *(user.User.Sid.cast::<u8>().add(1)) } as usize;
        let sid_len = 8 + count * 4;
        if count > 15
            || sid_start.saturating_add(sid_len) > start + required as usize
            || unsafe { IsValidSid(user.User.Sid) } == 0
        {
            return Err(permissions_error());
        }
        let sid =
            unsafe { std::slice::from_raw_parts(user.User.Sid.cast::<u8>(), sid_len) }.to_vec();
        let mut string_sid = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut string_sid) } == 0 {
            return Err(permissions_error());
        }
        let allocated = LocalAllocation(string_sid.cast());
        let text = String::from_utf16(&unsafe { wide_string(string_sid) }?)
            .map_err(|_| permissions_error())?;
        drop(allocated);
        let sddl = format!("O:{text}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{text})");
        let mut descriptor = ptr::null_mut();
        let wide: Vec<_> = sddl.encode_utf16().chain(Some(0)).collect();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(permissions_error());
        }
        Ok(Self {
            sid,
            descriptor: LocalAllocation(descriptor),
        })
    }
}
fn open_directory(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| path_error())?;
    let metadata = file.metadata().map_err(|_| path_error())?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(path_error());
    }
    Ok(file)
}
fn check_private(file: &File, identity: &Identity) -> Result<()> {
    let (mut owner, mut dacl, mut descriptor) = (ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
    let result = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    let _allocated = LocalAllocation(descriptor);
    if result != 0 || owner.is_null() || dacl.is_null() || descriptor.is_null() {
        return Err(permissions_error());
    }
    let (mut control, mut revision) = (0, 0);
    if unsafe { IsValidSid(owner) } == 0
        || unsafe { IsValidAcl(dacl) } == 0
        || unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
    {
        return Err(permissions_error());
    }
    let sid_len = unsafe { GetLengthSid(owner) } as usize;
    let acl_len = unsafe { (*dacl).AclSize } as usize;
    if !(8..=68).contains(&sid_len) || !(8..=65535).contains(&acl_len) {
        return Err(permissions_error());
    }
    // GetSecurityInfo owns and validates these returned SID/ACL allocations;
    // the bounded, alignment-independent policy parser checks every ACE.
    let owner = unsafe { std::slice::from_raw_parts(owner.cast::<u8>(), sid_len) };
    let acl = unsafe { std::slice::from_raw_parts(dacl.cast::<u8>(), acl_len) };
    if !policy::private_acl(owner, &identity.sid, control, acl) {
        return Err(permissions_error());
    }
    Ok(())
}
fn create_private(path: &Path, identity: &Identity) -> Result<()> {
    let mut wide: Vec<_> = match path.components().next() {
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)) => {
            let mut value: Vec<_> = r"\\?\".encode_utf16().collect();
            value.extend(
                path.as_os_str()
                    .encode_wide()
                    .map(|c| if c == 47 { 92 } else { c }),
            );
            value
        }
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_)) => {
            path.as_os_str().encode_wide().collect()
        }
        _ => return Err(path_error()),
    };
    wide.push(0);
    if wide[..wide.len() - 1].contains(&0) {
        return Err(path_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: identity.descriptor.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0
        && unsafe { GetLastError() } != ERROR_ALREADY_EXISTS
    {
        return Err(path_error());
    }
    Ok(())
}
fn pin_ancestors(path: &Path) -> Result<Vec<File>> {
    let mut components = path.components();
    if !matches!(components.next(),Some(Component::Prefix(prefix)) if matches!(prefix.kind(),Prefix::Disk(_)|Prefix::VerbatimDisk(_)))
        || !matches!(components.next(), Some(Component::RootDir))
    {
        return Err(path_error());
    }
    let mut current = PathBuf::new();
    let mut handles = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) => current.push(component.as_os_str()),
            Component::RootDir => {
                current.push(component.as_os_str());
                handles.push(open_directory(&current)?);
            }
            Component::Normal(part) => {
                current.push(part);
                handles.push(open_directory(&current)?);
            }
            _ => return Err(path_error()),
        }
    }
    Ok(handles)
}
fn exists(path: &Path) -> Result<bool> {
    match path.symlink_metadata() {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(path_error()),
    }
}
struct RootAnchor {
    _handles: Vec<File>,
}
struct ModelGate {
    _store: JournalStore,
    _directory: File,
    _root: Arc<RootAnchor>,
}
struct DeviceAnchor {
    _directory: File,
    _gate: Arc<ModelGate>,
}
/// A fixed per-user v1 recovery root. No caller-supplied path or environment
/// override is accepted by the production constructor.
pub struct RecoveryRoot {
    path: PathBuf,
    identity: Identity,
    anchor: Arc<RootAnchor>,
}
pub struct DeviceDirectory {
    path: PathBuf,
    model: Model,
    anchor: Arc<DeviceAnchor>,
}
impl RecoveryRoot {
    #[cfg(test)]
    pub(crate) fn open_test_root(parent: &Path) -> Result<Self> {
        Self::open_under(parent)
    }
    pub fn open() -> Result<Self> {
        Self::open_under(&known_folder()?)
    }
    pub fn open_existing() -> Result<Option<Self>> {
        Self::existing_under(&known_folder()?)
    }
    fn existing_under(parent: &Path) -> Result<Option<Self>> {
        let identity = Identity::current()?;
        let mut handles = pin_ancestors(parent)?;
        let app = parent.join("NuPhyLab");
        if !exists(&app)? {
            return Ok(None);
        }
        handles.push(open_directory(&app)?);
        let path = app.join(PRIVATE_ROOT);
        if !exists(&path)? {
            return Ok(None);
        }
        let private = open_directory(&path)?;
        check_private(&private, &identity)?;
        handles.push(private);
        Ok(Some(Self {
            path,
            identity,
            anchor: Arc::new(RootAnchor { _handles: handles }),
        }))
    }
    fn open_under(parent: &Path) -> Result<Self> {
        let identity = Identity::current()?;
        let mut handles = pin_ancestors(parent)?;
        let app = parent.join("NuPhyLab");
        create_private(&app, &identity)?;
        handles.push(open_directory(&app)?);
        let path = app.join(PRIVATE_ROOT);
        create_private(&path, &identity)?;
        let private = open_directory(&path)?;
        check_private(&private, &identity)?;
        handles.push(private);
        Ok(Self {
            path,
            identity,
            anchor: Arc::new(RootAnchor { _handles: handles }),
        })
    }
    /// The native factory alone supplies the connection's qualified identity.
    /// Unverified connections share one slot; new tokens cannot hide records.
    pub fn device(&self, model: &Model, connection: &Connection) -> Result<DeviceDirectory> {
        self.device_mode(model, connection, true)?
            .ok_or_else(path_error)
    }
    pub fn existing_device(
        &self,
        model: &Model,
        connection: &Connection,
    ) -> Result<Option<DeviceDirectory>> {
        self.device_mode(model, connection, false)
    }
    fn device_mode(
        &self,
        model: &Model,
        connection: &Connection,
        initialize: bool,
    ) -> Result<Option<DeviceDirectory>> {
        let (model_key, slot) = policy::keys(model, connection)?;
        let directory = self.path.join(model_key);
        if initialize {
            create_private(&directory, &self.identity)?;
        } else if !exists(&directory)? {
            return Ok(None);
        }
        let handle = open_directory(&directory)?;
        check_private(&handle, &self.identity)?;
        let gate = Arc::new(ModelGate {
            _store: if initialize {
                JournalStore::open(&directory, model)?
            } else {
                JournalStore::open_existing(&directory, model)?
            },
            _directory: handle,
            _root: Arc::clone(&self.anchor),
        });
        if gate._store.recovery_status()?.has_pending() {
            return Err(error(
                "RECOVERY_REQUIRED",
                "型号目录存在未处理记录，不能另建基线",
            ));
        }
        let entries = fs::read_dir(&directory).map_err(|_| path_error())?;
        let mut slots = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| path_error())?;
            let name = entry.file_name();
            if name == "session.lock" {
                continue;
            }
            let name = name.to_str().ok_or_else(path_error)?;
            if !policy::valid_slot(name) {
                return Err(error(
                    "RECOVERY_STORAGE_LAYOUT",
                    "恢复目录包含未知项目，原内容已保留",
                ));
            }
            slots.push(name.to_string());
            if slots.len() > MAX_SLOTS {
                return Err(error(
                    "RECOVERY_STORAGE_LAYOUT",
                    "恢复目录项目过多，已停止自动选择",
                ));
            }
        }
        if slots.len() == MAX_SLOTS && !slots.iter().any(|name| name == &slot) {
            return Err(error(
                "RECOVERY_STORAGE_LAYOUT",
                "恢复目录已达数量上限，不能再建立新目录",
            ));
        }
        // A verified ID cannot bypass old unknown-ID originals, nor can loss
        // of identity turn a verified pending record into a fresh unknown slot.
        for other in slots {
            let handle = open_directory(&directory.join(&other))?;
            check_private(&handle, &self.identity)?;
            if other != slot && (slot == UNVERIFIED || other == UNVERIFIED) {
                let store = if initialize {
                    JournalStore::open(&directory.join(&other), model)?
                } else {
                    JournalStore::open_existing(&directory.join(&other), model)?
                };
                if store.recovery_status()?.has_pending() {
                    return Err(error(
                        "RECOVERY_REQUIRED",
                        "原生设备身份类别变化且已有恢复记录，不能另建目录绕过",
                    ));
                }
            }
        }
        let path = directory.join(slot);
        if !exists(&path)? {
            if !initialize {
                return Ok(None);
            }
            create_private(&path, &self.identity)?;
        }
        let handle = open_directory(&path)?;
        check_private(&handle, &self.identity)?;
        Ok(Some(DeviceDirectory {
            path,
            model: model.clone(),
            anchor: Arc::new(DeviceAnchor {
                _directory: handle,
                _gate: gate,
            }),
        }))
    }
}
impl DeviceDirectory {
    pub fn existing_journal_store(&self) -> Result<JournalStore> {
        JournalStore::open_existing_with_directory_guard(
            &self.path,
            &self.model,
            Arc::clone(&self.anchor),
        )
    }
    pub fn journal_store(&self) -> Result<JournalStore> {
        JournalStore::open_with_directory_guard(&self.path, &self.model, Arc::clone(&self.anchor))
    }
    pub fn recovery_status(&self) -> Result<RecoveryStatus> {
        self.journal_store()?.recovery_status()
    }
}

#[cfg(test)]
mod tests;
