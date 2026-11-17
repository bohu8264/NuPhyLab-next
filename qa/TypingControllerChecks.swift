import AppKit

// Native controller with an inert audio boundary. No output device, microphone,
// HID, event tap, key events, real user data or permission prompt is used.
final class TypingSoundBank { let id:String;init(_ id:String){self.id=id} }
final class TypingSoundEngine {
    static var latest:TypingSoundEngine?
    var configurationChanged:(()->Void)?
    var previews=0,stops=0,loads=0
    var pending:((Result<TypingSoundBank,Error>)->Void)?
    var deferLoad=false
    init(){Self.latest=self}
    func load(_ pack:TypingSoundPack,root:URL,completion:@escaping(Result<TypingSoundBank,Error>)->Void){loads+=1;if deferLoad{pending=completion}else{completion(.success(TypingSoundBank(pack.id)))}}
    func prepare(completion:@escaping(Bool)->Void){completion(true)}
    func update(_ value:TypingSoundPreferences){}
    func hit(_ bank:TypingSoundBank,group:TypingKeyGroup,release:Bool,received:TimeInterval){fatalError("Test must never receive key events")}
    func preview(_ bank:TypingSoundBank,groups:[TypingKeyGroup],completion:@escaping()->Void){previews+=1}
    func stop(pause:Bool=false,rebuild:Bool=false){stops+=1}
}
@main struct TypingControllerChecks {
    @MainActor static func main() throws {
        let temp=URL(fileURLWithPath:CommandLine.arguments[2]),resources=temp.appendingPathComponent("resources")
        try FileManager.default.createDirectory(at:resources.appendingPathComponent("typing-sounds"),withIntermediateDirectories:true)
        try FileManager.default.copyItem(at:URL(fileURLWithPath:CommandLine.arguments[1]),to:resources.appendingPathComponent("typing-sounds/catalog.json"))
        var secure=false,checks=[[String:Any]]()
        func check(_ name:String,_ result:Bool){checks.append(["name":name,"passed":result])}
        let host=TypingSoundController(directory:temp.appendingPathComponent("data"),resources:resources,automaticallyObserve:false,inputAccess:{false},secureInput:{secure})
        let audio=TypingSoundEngine.latest!
        func call(_ op:String,_ value:[String:Any]=[:])->[String:Any]{
            var body=value;body["op"]=op;var result=[String:Any]()
            host.handle(body){response,error in result=response as? [String:Any] ?? ["error":error ?? "missing"]};return result
        }
        check("first launch off / no decoding",call("status")["state"] as? String=="off" && audio.loads==0)
        check("enable waits for permission",call("save",["patch":["enabled":true]])["state"] as? String=="permission")
        check("click preview needs no grant",call("preview",["pack":"wood-bamboo"])["previewing"] as? Bool==true && audio.previews==1)
        let before=audio.stops
        for _ in 0..<5 {_=call("refresh")}
        check("permission polling leaves click preview running",call("status")["previewing"] as? Bool==true && audio.stops==before)
        host.setPaused("inactive",active:true);host.setPaused("display",active:true);host.setPaused("display",active:false)
        check("display wake cannot clear inactive session",call("status")["reason"] as? String=="session" && call("preview",["pack":"wood-bamboo"])["error"] as? String=="unavailable")
        host.setPaused("inactive",active:false)
        check("all session reasons released permits preview",call("preview",["pack":"wood-bamboo"])["previewing"] as? Bool==true)
        host.setPaused("quitting",active:true);host.setPaused("quitting",active:false)
        check("cancelled quit is recoverable",call("preview",["pack":"wood-bamboo"])["previewing"] as? Bool==true)
        host.setPaused("selectionVoice",active:true);host.setPaused("dictation:one",active:true);host.setPaused("selectionVoice",active:false)
        check("one recording release cannot clear another",call("preview",["pack":"wood-bamboo"])["error"] as? String=="unavailable")
        host.setPaused("dictationUnconfirmed",active:true);host.setPaused("dictation:one",active:false)
        check("unconfirmed dictation remains muted",call("status")["reason"] as? String=="dictationUnconfirmed")
        _=call("save",["patch":["enabled":false]])
        check("explicit off resets unconfirmed state",call("preview",["pack":"wood-bamboo"])["previewing"] as? Bool==true)
        secure=true;_=call("refresh")
        check("secure input interrupts and rejects preview",call("status")["previewing"] as? Bool==false && call("preview",["pack":"wood-bamboo"])["error"] as? String=="unavailable")
        secure=false;_=call("refresh")
        audio.deferLoad=true;_=call("preview",["pack":"wood-bamboo"]);_=call("stopPreview")
        let previewCount=audio.previews;audio.pending?(.success(TypingSoundBank("wood-bamboo")))
        check("late decode after stop does not play",audio.previews==previewCount && call("status")["previewing"] as? Bool==false)
        _=call("preview",["pack":"wood-bamboo"]);secure=true
        let countBeforeSecure=audio.previews;audio.pending?(.success(TypingSoundBank("wood-bamboo")))
        check("secure input blocks late decode before next poll",audio.previews==countBeforeSecure && call("status")["previewing"] as? Bool==false)
        secure=false;_=call("refresh")
        let saved=try Data(contentsOf:temp.appendingPathComponent("data/typing-sound-preferences.json"))
        _=call("save",["patch":["volume":-1]])
        check("invalid save preserves existing file",try Data(contentsOf:temp.appendingPathComponent("data/typing-sound-preferences.json"))==saved)
        for value:[String:Any] in [["released":true,"observedState":"recording"],["released":false,"observedState":"idle"],["released":true],[:]] {
            check("untrusted dictation stop rejected",!TypingDictationCompletion.confirmed(value))
        }
        check("confirmed stop accepts idle and finishing",TypingDictationCompletion.confirmed(["released":true,"observedState":"idle"]) && TypingDictationCompletion.confirmed(["released":true,"observedState":"finishing"]))
        _=call("save",["patch":["enabled":true,"volume":43]])
        host.setFeatureAdded(false)
        check("feature center stops sounds",call("status")["state"] as? String=="off")
        _=call("save",["patch":["enabled":true]])
        check("hidden feature rejects enable",(call("status")["preferences"] as? [String:Any])?["enabled"] as? Bool==false)
        host.setPaused("inactive",active:true);host.setPaused("inactive",active:false);host.setFeatureAdded(true)
        check("re-add and session recovery keep off",call("status")["state"] as? String=="off")
        let disk=try JSONSerialization.jsonObject(with:Data(contentsOf:temp.appendingPathComponent("data/typing-sound-preferences.json"))) as! [String:Any]
        check("off persisted, sound preferences retained",disk["enabled"] as? Bool==false && disk["volume"] as? Int==43)
        host.shutdown();check("final shutdown rejects messages",call("preview",["pack":"wood-bamboo"])["error"] as? String=="unavailable")
        print(String(data:try JSONSerialization.data(withJSONObject:["checks":checks,"passed":checks.allSatisfy{$0["passed"] as? Bool==true},"count":checks.count,"usesRealInputOrAudio":false],options:[.sortedKeys]),encoding:.utf8)!)
        if !checks.allSatisfy({$0["passed"] as? Bool==true}) {exit(1)}
    }
}
