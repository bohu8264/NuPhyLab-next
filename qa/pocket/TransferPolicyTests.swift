import Foundation
@main struct TransferTests {
 static func main() {
  var count=0
  func check(_ condition:Bool,_ name:String){if !condition{fatalError(name)};count += 1}
  check(PocketTransferPolicy.allowsTarget(sameApplication:true,focus:.unavailable,window:.unavailable,secure:false),"Editors without AX object IDs can paste")
  check(PocketTransferPolicy.allowsTarget(sameApplication:true,focus:.same,window:.same,secure:false),"same editor")
  check(!PocketTransferPolicy.allowsTarget(sameApplication:false,focus:.same,window:.same,secure:false),"other app cancels")
  check(!PocketTransferPolicy.allowsTarget(sameApplication:true,focus:.different,window:.same,secure:false),"different input cancels")
  check(!PocketTransferPolicy.allowsTarget(sameApplication:true,focus:.same,window:.different,secure:false),"different window cancels")
  check(!PocketTransferPolicy.allowsTarget(sameApplication:true,focus:.unavailable,window:.unavailable,secure:true),"secure input cancels")
  check(!PocketTransferPolicy.mayCollectSelection(initialChange:10,currentChange:10,sameTarget:true),"no new copy must not collect stale clipboard")
  check(!PocketTransferPolicy.mayCollectSelection(initialChange:10,currentChange:11,sameTarget:false),"copy after target change ignored")
  check(PocketTransferPolicy.mayCollectSelection(initialChange:10,currentChange:11,sameTarget:true),"new selected content accepted")
  check(!PocketTransferPolicy.mayConsumeItem(selectedID:"old",currentID:"new",pinned:false),"replacement survives deferred consumption")
  check(!PocketTransferPolicy.mayConsumeItem(selectedID:"same",currentID:"same",pinned:true),"pinned survives")
  check(PocketTransferPolicy.mayConsumeItem(selectedID:"same",currentID:"same",pinned:false),"selected original consumed")
  check(PocketTransferPolicy.identityMatch(hadOriginal:true,hasCurrent:false,equal:false) == .different,"Known AX field disappearing cancels")
  check(PocketTransferPolicy.identityMatch(hadOriginal:false,hasCurrent:false,equal:false) == .unavailable,"Initially unavailable AX can fallback")
  check(PocketTransferPolicy.identityMatch(hadOriginal:true,hasCurrent:true,equal:false) == .different,"Different AX fields cancel")
  check(PocketTransferPolicy.identityMatch(hadOriginal:true,hasCurrent:true,equal:true) == .same,"Original AX field preserved")
  print("PocketTransferPolicy: \(count) checks passed")
 }
}
