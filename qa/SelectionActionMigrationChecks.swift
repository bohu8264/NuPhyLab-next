import AppKit
import Foundation

@MainActor func selectionActionMigrationChecks(_ check:(Bool,String)->Void) throws {
 let decoder=JSONDecoder(),encoder=JSONEncoder()
 var original=LabPreferences();original.enabled=true;original.defaultAction = .reply;original.shortcut = .mouseButton(4);original.voiceEnabled=true;original.translationLanguage = .japanese
 original.configuration=AIConfiguration(provider:.custom,endpoint:"https://fixture.invalid/v1/chat/completions",model:"fixture-vision",imageInputConfirmed:true)
 var saved=try JSONSerialization.jsonObject(with:encoder.encode(original)) as! [String:Any]
 saved.removeValue(forKey:"enabledActions")
 let prior=try decoder.decode(LabPreferences.self,from:JSONSerialization.data(withJSONObject:saved))
 check(prior.availableActions==LabAction.allCases && prior.defaultAction == .reply,"old four-action profile retains its default")
 for mask in 1..<16 {
  let actions=LabAction.allCases.enumerated().filter{mask & (1 << $0.offset) != 0}.map(\.element)
  for defaultID in actions.map(\.rawValue)+["identify"] {
   saved["enabledActions"]=actions.map(\.rawValue)+["identify","future-mode","identify"]
   saved["defaultAction"]=defaultID;saved["identifySearchProvider"]="googleVision"
   let migrated=try decoder.decode(LabPreferences.self,from:JSONSerialization.data(withJSONObject:saved))
   check(migrated.availableActions==actions,"removed and unknown actions never reappear")
   check(migrated.defaultAction == (LabAction(rawValue:defaultID) ?? actions[0]),"valid default survives; retired default selects first remaining action")
   check(migrated.shortcut==original.shortcut && migrated.configuration==original.configuration && migrated.voiceEnabled && migrated.enabled && migrated.translationLanguage == .japanese,"migration preserves input, model, image, voice, translation and enabled settings")
   let canonical=try JSONSerialization.jsonObject(with:encoder.encode(migrated)) as! [String:Any]
   check(canonical["identifySearchProvider"]==nil && !(canonical["enabledActions"] as! [String]).contains("identify"),"subsequent save drops retired settings")
   for (index,action) in actions.enumerated() {
    check(action.stepped(1,among:actions)==actions[(index+1)%actions.count],"wheel forward only visits enabled actions")
    check(action.stepped(-1,among:actions)==actions[(index+actions.count-1)%actions.count],"wheel reverse only visits enabled actions")
   }
  }
 }
 for ids in [["identify"],["identify","future-mode"],[]] {
  saved["enabledActions"]=ids;saved["defaultAction"]="identify"
  let migrated=try decoder.decode(LabPreferences.self,from:JSONSerialization.data(withJSONObject:saved))
  check(migrated.availableActions == [.translate] && migrated.defaultAction == .translate,"retired-only selection recovers to Translate")
  let reopened=try decoder.decode(LabPreferences.self,from:encoder.encode(migrated))
  check(reopened.availableActions == [.translate] && reopened.shortcut==original.shortcut,"migration persists through reopening")
 }
 saved["enabledActions"]=[];saved["defaultAction"]="reply"
 let empty=try decoder.decode(LabPreferences.self,from:JSONSerialization.data(withJSONObject:saved))
 check(empty.availableActions == [.reply] && empty.defaultAction == .reply,"empty list keeps a valid saved default")
 check(LabAction(rawValue:"identify")==nil && LabAction.allCases.count==4,"retired action is not executable")
}
