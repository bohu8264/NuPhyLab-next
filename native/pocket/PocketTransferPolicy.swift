import Foundation

/// Matching AX objects are useful when available, but some editors do not expose them.
/// Unknown accessibility identity must not disable a user-requested standard paste.
enum PocketIdentityMatch { case same, different, unavailable }
enum PocketTransferPolicy {
    static func shouldCancelForUserInput(transferPending:Bool,confirmationOpen:Bool,filePickerOpen:Bool)->Bool {
        transferPending && !confirmationOpen && !filePickerOpen
    }
    static func identityMatch(hadOriginal:Bool,hasCurrent:Bool,equal:Bool)->PocketIdentityMatch {
        if !hadOriginal{return .unavailable}
        if !hasCurrent{return .different}
        return equal ? .same : .different
    }
    static func allowsTarget(sameApplication:Bool, focus:PocketIdentityMatch, window:PocketIdentityMatch, secure:Bool)->Bool {
        sameApplication && !secure && focus != .different && window != .different
    }
    static func mayCollectSelection(initialChange:Int,currentChange:Int,sameTarget:Bool)->Bool {
        currentChange != initialChange && sameTarget
    }
    static func mayConsumeItem(selectedID:String,currentID:String?,pinned:Bool)->Bool {
        currentID == selectedID && !pinned
    }
}
