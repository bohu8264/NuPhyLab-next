use super::*;
const BUDGET: Duration = Duration::from_secs(30);
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionKeyCompletion {
    pub verified: bool,
    pub no_mutation: bool,
    pub archived: bool,
    pub restored_keys: usize,
    pub external_changes_preserved: bool,
}
/// This is a native scope, not an input credential. The enclosing USB owner
/// must restore on close/EOF/heartbeat loss and keep exclusive transport access.
pub struct FunctionKeyLease {
    pub(super) journal: Journal,
    model: Model,
    connection: Connection,
    key: u8,
    original: Original,
    mutation_attempted: bool,
    completion: Option<FunctionKeyCompletion>,
}
impl FunctionKeyLease {
    /// None means every requested position already used its extended value.
    /// No record or ownership proof is created for someone else's mappings.
    pub fn prepare(
        transport: &mut impl Transport,
        model: &Model,
        store: &JournalStore,
        requested: &[u8],
    ) -> Result<Option<Self>> {
        store.require_model(model)?;
        if store.recovery_status()?.has_pending() {
            return Err(error(
                "RECOVERY_REQUIRED",
                "已有待处理原记录，不能接管功能键",
            ));
        }
        let connection = transport.connection();
        Self::prepare_scoped(transport, model, requested, connection, None, |original| {
            Journal::create(store, original)
        })
    }
    pub(crate) fn prepare_for_lighting(
        transport: &mut impl Transport,
        model: &Model,
        transaction: &mut crate::recovery::Transaction<'_>,
        requested: &[u8],
        connection: &Connection,
        key: u8,
    ) -> Result<Option<Self>> {
        Self::prepare_scoped(
            transport,
            model,
            requested,
            connection.clone(),
            Some(key),
            |original| Journal::create_for_lighting(transaction, original),
        )
    }
    fn prepare_scoped(
        transport: &mut impl Transport,
        model: &Model,
        requested: &[u8],
        connection: Connection,
        expected_key: Option<u8>,
        create: impl FnOnce(&Original) -> Result<Journal>,
    ) -> Result<Option<Self>> {
        let deadline = Instant::now() + BUDGET;
        let observed = observe(transport, model, &connection, deadline)?;
        if expected_key.is_some_and(|key| key != observed.key) {
            return Err(error(
                "FUNCTION_KEYS_CONNECTION_CHANGED",
                "现有所有者的密钥已变化，未创建功能键记录",
            ));
        }
        let binding = binding(model, &connection, &observed)?;
        let mut requested = requested.to_vec();
        requested.sort_unstable();
        let changes = assignments(
            model,
            &observed.map.active,
            &observed.map.defaults,
            &requested,
        )?;
        if changes.is_empty() {
            return Ok(None);
        }
        settle(transport, deadline)?;
        let after_barrier = observe(transport, model, &connection, deadline)?;
        if observed.firmware != after_barrier.firmware
            || observed.geometry != after_barrier.geometry
            || observed.key != after_barrier.key
            || observed.map.active != after_barrier.map.active
            || observed.map.defaults != after_barrier.map.defaults
        {
            return Err(error(
                "FUNCTION_KEYS_CHANGED",
                "确认提交期间原键位已变化，未保存过时基线",
            ));
        }
        let original = Original {
            binding,
            firmware: observed.firmware,
            geometry: observed.geometry,
            active: observed.map.active,
            defaults: observed.map.defaults,
            requested,
            assignments: changes,
        };
        let journal = create(&original)?;
        let mut lease = Self {
            journal,
            model: model.clone(),
            connection,
            key: observed.key,
            original,
            mutation_attempted: false,
            completion: None,
        };
        if let Err(cause) = lease.install(transport, deadline) {
            return Err(match lease.restore(transport) {
                Ok(_) => cause,
                Err(recovery) => error(
                    "FUNCTION_KEYS_RESTORE_REQUIRED",
                    &format!(
                        "临时改键未完成：{}；原键位恢复未确认：{}，原记录已保留",
                        cause.message, recovery.message
                    ),
                ),
            });
        }
        Ok(Some(lease))
    }
    pub(crate) fn validate_journal(&self) -> Result<()> {
        self.journal.intact()
    }
    fn read(&self, transport: &mut impl Transport, deadline: Instant) -> Result<Observation> {
        self.journal.intact()?;
        let observed = observe(transport, &self.model, &self.connection, deadline)?;
        verify(&self.original, &self.model, &self.connection, &observed)?;
        if observed.key != self.key {
            return Err(error(
                "FUNCTION_KEYS_CONNECTION_CHANGED",
                "当前所有者的密钥已变化，未继续写入",
            ));
        }
        self.journal.intact()?;
        Ok(observed)
    }
    fn exact(&self, observed: &Observation, expected: &[u16]) -> Result<()> {
        if observed.map.active != expected {
            return Err(error(
                "FUNCTION_KEYS_CHANGED",
                "完整键位已在事务之外发生变化，停止继续写入并保留原记录",
            ));
        }
        Ok(())
    }
    fn readback(
        &self,
        transport: &mut impl Transport,
        expected: &[u16],
        position: usize,
        previous: u16,
        deadline: Instant,
    ) -> Result<()> {
        for delay in [0, 20, 40] {
            if delay > 0 {
                let duration = Duration::from_millis(delay);
                if deadline.saturating_duration_since(Instant::now()) < duration {
                    return Err(error("FUNCTION_KEYS_TIMEOUT", "键位确认超出本次操作期限"));
                }
                transport.pause(duration)?;
            }
            let observed = self.read(transport, deadline)?;
            if observed.map.active == expected {
                return Ok(());
            }
            // Only the one pending cell may lag. A different cell is not an
            // eventually-consistent ACK and must never authorize another write.
            let diffs: Vec<_> = observed
                .map
                .active
                .iter()
                .zip(expected)
                .enumerate()
                .filter(|(_, (a, b))| a != b)
                .map(|(i, _)| i)
                .collect();
            if diffs.len() != 1 || diffs[0] != position || observed.map.active[position] != previous
            {
                return Err(error("FUNCTION_KEYS_CHANGED", "读回发现事务之外的键位变化"));
            }
        }
        Err(error(
            "FUNCTION_KEYS_VERIFY_FAILED",
            "临时改键未通过完整矩阵读回，不重发写入",
        ))
    }
    fn install(&mut self, transport: &mut impl Transport, deadline: Instant) -> Result<()> {
        self.journal.authorize()?;
        let mut expected = self.original.active.clone();
        for assignment in &self.original.assignments {
            let before = self.read(transport, deadline)?;
            self.exact(&before, &expected)?;
            self.mutation_attempted = true;
            // The intent and current matrix were checked immediately before
            // the sole B3 request. A timeout never retries this write.
            self.journal.intact()?;
            write_once(
                transport,
                &self.model,
                &self.original,
                assignment,
                assignment.installed,
                before.key,
                deadline,
            )?;
            expected[assignment.position] = assignment.installed;
            self.readback(
                transport,
                &expected,
                assignment.position,
                assignment.original,
                deadline,
            )?;
        }
        let observed = self.read(transport, deadline)?;
        self.exact(&observed, &expected)
    }
    pub fn restore(&mut self, transport: &mut impl Transport) -> Result<FunctionKeyCompletion> {
        if let Some(done) = &self.completion {
            return Ok(done.clone());
        }
        transport.begin_recovery();
        let deadline = Instant::now() + BUDGET;
        self.read(transport, deadline)?;
        // This includes a previous process's uncertain B3. A fresh read of
        // the original alone cannot rule out a deferred device commit.
        settle(transport, deadline)?;
        let before = self.read(transport, deadline)?;
        let has_intent = self.journal.has_intent();
        let completed = self.journal.completed();
        for assignment in &self.original.assignments {
            let value = before.map.active[assignment.position];
            if value != assignment.original
                && (!has_intent || completed || value != assignment.installed)
            {
                return Err(error(
                    "FUNCTION_KEYS_EXTERNAL_CHANGE",
                    "本次涉及的功能键已被另外配置，未覆盖其新用途",
                ));
            }
        }
        let external = before
            .map
            .active
            .iter()
            .zip(&self.original.active)
            .enumerate()
            .any(|(i, (a, b))| {
                a != b && !self.original.assignments.iter().any(|v| v.position == i)
            });
        let mut expected = before.map.active.clone();
        let mut restored = 0;
        for assignment in &self.original.assignments {
            if expected[assignment.position] == assignment.original {
                continue;
            }
            let fresh = self.read(transport, deadline)?;
            self.exact(&fresh, &expected)?;
            self.journal.intact()?;
            write_once(
                transport,
                &self.model,
                &self.original,
                assignment,
                assignment.original,
                fresh.key,
                deadline,
            )?;
            expected[assignment.position] = assignment.original;
            restored += 1;
            self.readback(
                transport,
                &expected,
                assignment.position,
                assignment.installed,
                deadline,
            )?;
        }
        let final_read = self.read(transport, deadline)?;
        self.exact(&final_read, &expected)?;
        let receipt = VerifiedKeyRestoration {
            original: self.original.clone(),
            observed: final_read.map.active,
        };
        self.journal.complete(&receipt)?;
        let done = FunctionKeyCompletion {
            verified: true,
            no_mutation: !self.mutation_attempted && !has_intent,
            archived: true,
            restored_keys: restored,
            external_changes_preserved: external,
        };
        self.completion = Some(done.clone());
        Ok(done)
    }
    /// A new connection is accepted only after its native stable identity,
    /// firmware, physical Win layer and fresh defaults match the saved record.
    pub fn recover_existing(
        transport: &mut impl Transport,
        model: &Model,
        store: &JournalStore,
    ) -> Result<FunctionKeyCompletion> {
        store.require_model(model)?;
        let connection = transport.connection();
        let observed = observe(transport, model, &connection, Instant::now() + BUDGET)?;
        let binding = binding(model, &connection, &observed)?;
        let journal = Journal::resume(store, &binding)?;
        let original = journal.original()?;
        verify(&original, model, &connection, &observed)?;
        let mut lease = Self {
            journal,
            model: model.clone(),
            connection,
            key: observed.key,
            original,
            mutation_attempted: true,
            completion: None,
        };
        lease.restore(transport)
    }
}
