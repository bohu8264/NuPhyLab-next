"""Check key-write and key-upload control flow in pinned 2.0.0.7, without execution.
Usage: python inspect_key_writes.py <2.0.0.7.bin> [--write]
Requires capstone==5.0.7. No peripheral emulation, HID or flashing is used.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys
from capstone import Cs, CS_ARCH_RISCV, CS_MODE_RISCV32, CS_MODE_RISCVC

ROOT = Path(__file__).resolve().parents[3]
SHA = '619685122bb1882ceaa032a902c32883774639eccc9b86402ea8f0e195c3f610'
FLASH = 0x13000


def inspect(image):
    if hashlib.sha256(image).hexdigest() != SHA:
        raise ValueError('Firmware hash mismatch; no qualification is inferred')
    cs = Cs(CS_ARCH_RISCV, CS_MODE_RISCV32 | CS_MODE_RISCVC)

    def instruction(offset, mnemonic, operands):
        item = next(cs.disasm(image[offset:offset + 4], offset), None)
        if item is None or (item.mnemonic, item.op_str) != (mnemonic, operands):
            raise ValueError(f'Unexpected pinned control flow at {offset:x}')

    # The startup copies image[4:0x2534] to RAM, matching the vector at
    # image+0xc (RAM+0x90 => image+0x94). This establishes the linked flash
    # address; the former color-only interpreter used a relocated 0x10000.
    instruction(0, 'j', '0x2538')
    instruction(0x2548, 'auipc', 'a0, 0xffffe')
    instruction(0x254c, 'addi', 'a0, a0, -0x544')
    instruction(0x2550, 'auipc', 'a1, 0x1ffeb')
    instruction(0x2554, 'addi', 'a1, a1, -0x550')
    instruction(0x2558, 'auipc', 'a2, 0x1ffed')
    instruction(0x255c, 'addi', 'a2, a2, -0x28')
    source = (FLASH + 0x2548 + (0xffffe << 12) - 0x544) & 0xffffffff
    destination = FLASH + 0x2550 + (0x1ffeb << 12) - 0x550
    end = FLASH + 0x2558 + (0x1ffed << 12) - 0x28
    assert source == FLASH + 4 and destination == 0x20000000 and end == 0x20002530
    assert struct.unpack_from('<I', image, 0xc)[0] == destination + 0x90
    table = 0x56894
    routes = {str(c): table + struct.unpack_from('<i', image, table + (c - 0x2f) * 4)[0]
              for c in [0xb1, 0xb2, 0xb3, 0xb4]}
    assert list(routes.values()) == [0x1aa22, 0x1aaae, 0x1aa9c, 0x1a88a]
    instruction(0x1a172, 'addi', 's6, s6, -0x2f')
    instruction(0x1a182, 'auipc', 'a5, 0x3c')
    instruction(0x1a186, 'addi', 'a5, a5, 0x712')
    instruction(0x1aaa4, 'jal', '-0x12e1c')  # B3 -> key storage wrapper.
    instruction(0x1aaa8, 'lbu', 't1, -0x45a(gp)')
    instruction(0x1aaac, 'c.j', '-0x674')     # No return-code check before reply.
    instruction(0x7d88, 'jal', '-0x4044')     # Each matrix byte -> compare/set.
    instruction(0x7d94, 'jal', '-0x4050')
    instruction(0x3d74, 'jal', '0x133c6')    # compare/set -> NVM write.
    instruction(0x3d78, 'c.lwsp', 'ra, 0x1c(sp)')
    instruction(0x172c0, 'c.li', 'a0, 0xa') # NVM program command.
    instruction(0x172c2, 'auipc', 'ra, 0x1ffd6')
    instruction(0x172c6, 'jalr', 'ra, ra, -0x174')
    ram_api = FLASH + 0x172c2 + (0x1ffd6 << 12) - 0x174
    assert ram_api == 0x2000014e
    assert 4 + ram_api - destination == 0x152
    # The RAM flash routine polls status, but its bounded timeout can return
    # failure. Static inspection does not establish a later successful fence.
    instruction(0x234, 'c.jal', '-0x11a')
    instruction(0x236, 'c.bnez', 'a0, -0x26')
    instruction(0x238, 'c.li', 'a0, -1')
    instruction(0x120, 'lui', 's1, 0x80')
    instruction(0x134, 'andi', 'a5, a0, 1')
    instruction(0x138, 'c.bnez', 'a5, 0x12')
    instruction(0x14a, 'c.addi', 's1, -1')
    instruction(0x14c, 'c.bnez', 's1, -0x26')
    instruction(0x14e, 'c.li', 'a0, 0')
    # The storage error latch is conditional, not a public completion
    # register. Its dedicated enable/disable scope is outside the B2/B3
    # command handlers; B2 also ignores its storage wrapper's return value.
    instruction(0x16fd6, 'sb', 'zero, -0x4c9(gp)')
    instruction(0x16fdc, 'sb', 'a5, -0x4ca(gp)')
    instruction(0x16fe2, 'lbu', 'a0, -0x4c9(gp)')
    instruction(0x16fe8, 'sb', 'zero, -0x4ca(gp)')
    instruction(0x16bde, 'c.jal', '0x3f8')
    instruction(0x16bfc, 'c.jal', '0x3ec')
    instruction(0x17070, 'lbu', 'a5, -0x4ca(gp)')
    instruction(0x1707a, 'c.beqz', 'a5, 0x2c')
    instruction(0x1aab6, 'jal', '-0x12c92')
    instruction(0x1aaba, 'lbu', 't1, -0x45a(gp)')
    instruction(0x1aabe, 'j', '-0x686')
    # C1 only establishes a RAM flag and the observed report-construction
    # path. A caller resumes another processing call with the same arguments;
    # this is not evidence of exclusive interception, freshness or ownership.
    upload_handler = table + struct.unpack_from('<i', image, table + (0xc1 - 0x2f) * 4)[0]
    assert upload_handler == 0x1a708
    instruction(0x1a708, 'lbu', 'a5, 8(s0)')
    instruction(0x1a710, 'sb', 'a5, -0x45c(gp)')
    instruction(0x19cc2, 'lbu', 'a5, -0x45c(gp)')
    instruction(0x19cc6, 'c.bnez', 'a5, 4')
    instruction(0x19cc8, 'c.jr', 'ra')
    instruction(0x19cd0, 'addi', 'a3, zero, -0x3f')
    instruction(0x19cd4, 'addi', 'a1, zero, 0x40')
    instruction(0x19cdc, 'sb', 'a3, 0(sp)')
    instruction(0x19ce0, 'sb', 'a4, 1(sp)')
    instruction(0x19ce4, 'sb', 'a5, 2(sp)')
    instruction(0x19ce8, 'sb', 'a2, 3(sp)')
    instruction(0x19d0a, 'jal', '0x2b08')
    instruction(0x97dc, 'jal', '0x104e6')
    instruction(0x97e0, 'c.mv', 'a2, s10')
    instruction(0x97e2, 'c.mv', 'a1, s0')
    instruction(0x97e4, 'c.mv', 'a0, s1')
    instruction(0x97e6, 'jal', '0x359e')
    return {
        'schema': 1, 'modelId': 'air75-v3', 'firmwareVersion': '2.0.0.7',
        'source': {'url': 'https://air75-v3-ansi-beta-firmware-v2007.netlify.app/',
                   'imageSha256': SHA, 'linkedFlashAddress': FLASH,
                   'method': 'Static decoding of pinned control flow; no firmware execution or HID'},
        'ramCopy': {'sourceImageOffset': 4, 'destination': destination, 'length': end - destination},
        'dispatch': {'entryImageOffset': 0x19f56, 'tableImageOffset': table, 'routes': routes},
        'write': {'handlerImageOffset': 0x1aa9c, 'storageImageOffset': 0x7c88,
                  'compareSetImageOffset': 0x3d44, 'nvmImageOffset': 0x1713a,
                  'flashApiRamAddress': ram_api, 'flashApiImageOffset': 0x152,
                  'statusPollImageOffset': 0x11a, 'statusPollLimit': 0x80000,
                  'statusPollMayReturnFailure': True, 'handlerChecksStorageReturn': False},
        'readbackLimits': {'b2HandlerChecksStorageReturn': False,
                           'storageErrorLatchRequiresSpecialMode': True,
                           'specialModeEnableImageOffset': 0x16fd6,
                           'specialModeDisableImageOffset': 0x16fe8,
                           'ordinaryReadIsNotACompletionReceipt': True},
        'keyUpload': {
            'command': 0xc1, 'handlerImageOffset': upload_handler,
            'ramFlagGpOffset': -0x45c, 'reportConstructionImageOffset': 0x19cc2,
            'observedConstruction': {'bufferLength': 64, 'markerByte': 0xc1,
                                     'argumentByteOffsets': [1, 2, 3]},
            'callerImageOffset': 0x97dc, 'nextProcessingCallImageOffset': 0x97e6,
            'nextProcessingTargetImageOffset': 0xcd84,
            'scope': 'Pinned construction and one caller only; not a wire-format or keyboard-function suppression proof.',
            'wireFormatQualified': False, 'suppressionQualified': False,
            'originalModeReadbackQualified': False, 'freshnessQualified': False,
            'productionEnableAllowed': False,
        },
        'vendorReference': {
            'repository': 'https://github.com/openwch/ch592',
            'revision': 'a46e0086f1ffb5e5502703970bff94888e67f4cb',
            'ispHeaderPath': 'EVT/EXAM/SRC/StdPeriphDriver/inc/ISP592.h',
            'ispHeaderSha256': '80e71e5b2a9dfc9f8eb34757343d4cd7499eff327b3690c30e9984184bf47262',
            'datasheetPath': 'Datasheet/CH592DS1_EN.PDF',
            'datasheetSha256': '5a4b7ac166cbd8a1dfaf97f5c9d058bcbb1fc549f87b03e499e69f68f7e7973a',
            'scope': 'SDK command identities and documented success/error convention only; no host-visible completion guarantee inferred.'},
        'qualification': {'ackAloneQualifiesCommit': False, 'keymapWriteEnabled': False,
                          'reasonCode': 'FUNCTION_KEYS_BARRIER_UNQUALIFIED',
                          'remaining': 'An independent successful completion fence, including lost-ACK/timeout and reopened-owner paths, is still required.'},
    }


if __name__ == '__main__':
    if len(sys.argv) not in [2, 3] or len(sys.argv) == 3 and sys.argv[2] != '--write':
        raise SystemExit(__doc__)
    result = inspect(Path(sys.argv[1]).read_bytes())
    target = ROOT / 'tests/fixtures/air75-v3-2.0.0.7-key-write-inspection.json'
    if len(sys.argv) == 3:
        target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    elif json.loads(target.read_text()) != result:
        raise ValueError('Committed inspection differs from pinned firmware')
    print('Verified B1–B4 storage routes and C1 report construction/caller; writes and exclusive input remain unqualified; no HID opened')
