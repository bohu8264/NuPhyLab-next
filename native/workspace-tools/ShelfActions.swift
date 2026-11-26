import AppKit
import PDFKit
import UniformTypeIdentifiers
import ImageIO

struct ShelfInput {
    let item:ShelfItem
    let url:URL
}

enum ShelfProcessing {
    static let textExtensions:Set<String>=["txt","md","csv","json","yaml","yml","xml","log","swift","js","ts","py","html","css","rtf","doc","docx","odt"]
    static func plain(_ input:ShelfInput, limit:Int=20000)throws->String {
        let ext=input.url.pathExtension.lowercased()
        if ext=="pdf" {
            let pdf=try DragDocumentConverter.document(input.url)
            var text=""
            for i in 0..<pdf.pageCount where text.count<limit {
                if let line=pdf.page(at:i)?.string {text+=line.prefix(limit-text.count)+"\n"}
            }
            return String(text.prefix(limit))
        }
        guard [.text,.link,.rich].contains(input.item.kind) || textExtensions.contains(ext) else{throw ShelfFailure.invalid}
        try DragOutput.validate(input.url,maxBytes:16*1024*1024)
        if ["rtf","doc","docx","odt"].contains(ext) {
            let type:NSAttributedString.DocumentType=ext=="rtf" ? .rtf : ext=="docx" ? .officeOpenXML : ext=="odt" ? .openDocument:.docFormat
            let s=try NSAttributedString(url:input.url,options:[.documentType:type],documentAttributes:nil)
            return String(s.string.prefix(limit))
        }
        let bytes=try Data(contentsOf:input.url,options:.mappedIfSafe)
        guard let value=String(data:bytes,encoding:.utf8) ?? String(data:bytes,encoding:.utf16) else{throw ShelfFailure.invalid}
        return String(value.prefix(limit))
    }
    static func thumb(_ url:URL, side:Int=240) -> CGImage? {
        guard let source=CGImageSourceCreateWithURL(url as CFURL,[kCGImageSourceShouldCache:false] as CFDictionary) else{return nil}
        return CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceThumbnailMaxPixelSize:side] as CFDictionary)
    }
    static func montage(_ images:[CGImage], edge:Int=600)throws->CGImage {
        guard !images.isEmpty,images.count<=24 else{throw ShelfFailure.invalid}
        let cols=Int(ceil(sqrt(Double(images.count)))),rows=(images.count+cols-1)/cols
        guard let ctx=CGContext(data:nil,width:cols*edge,height:rows*edge,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else{throw DragConvertError.encoding}
        ctx.setFillColor(CGColor(gray:0.94,alpha:1));ctx.fill(CGRect(x:0,y:0,width:cols*edge,height:rows*edge))
        ctx.interpolationQuality = .high
        for (i,img) in images.enumerated() {
            let factor=Double(edge-10)/Double(max(img.width,img.height)),w=Double(img.width)*factor,h=Double(img.height)*factor
            ctx.draw(img,in:CGRect(x:Double(i%cols*edge)+(Double(edge)-w)/2,y:Double((rows-1-i/cols)*edge)+(Double(edge)-h)/2,width:w,height:h))
        }
        guard let result=ctx.makeImage() else{throw DragConvertError.encoding};return result
    }
    static func process(_ inputs:[ShelfInput],op:String,parameter:String,stage:URL,control:DragJobControl) async throws->[URL] {
        guard !inputs.isEmpty,inputs.count<=128 else{throw ShelfFailure.empty}
        let urls=inputs.map(\.url)
        var prefs=DragConvertPreferences();prefs.outputDirectory=stage.path
        func textFile(_ text:String,_ name:String)throws->[URL] {
            guard !text.isEmpty else{throw ShelfFailure.empty}
            let out=stage.appendingPathComponent(name);try Data(text.utf8).write(to:out,options:.withoutOverwriting);return [out]
        }
        if op=="zip" {return [try DragArchiveConverter.convert(urls,to:.zip,preferences:prefs,control:control)]}
        if op=="pdf" {return [try DragDocumentConverter.convert(urls,to:.imagesPDF,preferences:prefs,control:control)]}
        if op=="montage" {
            let imgs=try urls.map{u -> CGImage in try control.check();guard let i=thumb(u,side:800) else{throw ShelfFailure.invalid};return i}
            let out=stage.appendingPathComponent("Collage.png");try DragImageConverter.encode(montage(imgs),to:out,format:.png,quality:1);return [out]
        }
        if op=="ocr" {
            var blocks:[String]=[]
            for u in urls {
                try control.check()
                guard let picture=thumb(u,side:2400),let data=AssistClipboard.png(picture) else{throw ShelfFailure.invalid}
                let text=try await AssistClipboard.ocr(data);if !text.isEmpty{blocks.append(text)}
            }
            return try textFile(blocks.joined(separator:"\n\n"),"OCR.txt")
        }
        if ["merge","links","markdown","plaintext","rtf"].contains(op) {
            let blocks=try inputs.map{try control.check();return try plain($0,limit:250000)};let text=blocks.joined(separator:"\n\n")
            if op=="links" {
                let detector=try NSDataDetector(types:NSTextCheckingResult.CheckingType.link.rawValue)
                var seen=Set<String>();let links=detector.matches(in:text,range:NSRange(text.startIndex...,in:text)).compactMap{$0.url?.absoluteString}.filter{seen.insert($0).inserted}
                return try textFile(links.joined(separator:"\n"),"Links.txt")
            }
            if op=="rtf" {
                let att=NSAttributedString(string:text);let data=try att.data(from:NSRange(location:0,length:att.length),documentAttributes:[.documentType:NSAttributedString.DocumentType.rtf]);let u=stage.appendingPathComponent("Text.rtf");try data.write(to:u);return [u]
            }
            return try textFile(text,op=="markdown" ? "Notes.md":"Text.txt")
        }
        return try inputs.enumerated().map{index,input in
            try control.check()
            if op=="rename" {
                let stem=parameter.trimmingCharacters(in:.whitespacesAndNewlines)
                guard DesktopShelfStore.safeComponent(stem),input.item.kind != .folder else{throw ShelfFailure.invalid}
                let base=String(format:"%@-%03d",stem,index+1),u=stage.appendingPathComponent(base).appendingPathExtension(input.url.pathExtension)
                try FileManager.default.copyItem(at:input.url,to:u);return u
            }
            let format:DragFormat
            switch op {case "jpg","compress":format = .jpg;case "webp":format = .webp;case "png","resize","metadata":format = .png;default:throw ShelfFailure.invalid}
            let edge=op=="resize" ? Int(parameter):nil
            if op=="resize" && !(32...12000).contains(edge ?? -1){throw ShelfFailure.invalid}
            let image=try DragImageConverter.decode(input.url,maxDimension:edge)
            return try DragOutput.write(input:input.url,preferences:prefs,suffix:op=="metadata" ? "-clean":"",ext:format.fileExtension){out in
                try DragImageConverter.encode(image,to:out,format:format,quality:op=="compress" ? 0.62:0.88,check:control.check)
            }
        }
    }
    static func prompt(_ inputs:[ShelfInput],question:String,config:AIConfiguration) async throws->(AIRequestPrompt,[AIImageAttachment]) {
        guard !inputs.isEmpty,inputs.count<=24 else{throw ShelfFailure.quota}
        var content:[String]=[], images:[CGImage]=[], names:[String]=[]
        for input in inputs {
            try Task.checkCancellation()
            if input.item.kind == .image || DragFileKind.kind(input.url) == .image {
                guard let img=thumb(input.url,side:1600) else{throw ShelfFailure.invalid}
                if config.imageInputConfirmed {
                    images.append(img);names.append(input.item.title)
                } else {
                    guard let data=AssistClipboard.png(img) else{throw ShelfFailure.invalid}
                    let recognized=try await AssistClipboard.ocr(data)
                    guard !recognized.isEmpty else{throw AIError.imagesDisabled}
                    content.append(input.item.title+"\n"+recognized)
                }
            } else if input.item.kind == .folder { throw ShelfFailure.invalid }
            else {content.append(input.item.title+"\n"+(try plain(input,limit:max(3000,22000/inputs.count))))}
        }
        var attachments:[AIImageAttachment]=[]
        if !images.isEmpty {
            let combined=images.count==1 ? images[0]:try montage(images,edge:images.count<=4 ? 760:400)
            guard let png=AssistClipboard.png(combined) else{throw ShelfFailure.invalid}
            attachments=[.init(label:"Selected images",png:try AssistClipboard.attachment(png))]
            content.append("Images in reading order, left to right and top to bottom:\n"+names.enumerated().map{"\($0.offset+1). \($0.element)"}.joined(separator:"\n"))
        }
        return (try AIRequestPrompt.selection(text:content.joined(separator:"\n\n"),instruction:question),attachments)
    }
}

enum ShelfPasteboard {
    static let types:[NSPasteboard.PasteboardType]=[.fileURL,.URL,.rtf,.png,.tiff,.init("public.jpeg"),.init("public.heic"),.string,.html]
    static let reorder=NSPasteboard.PasteboardType("local.airstudio.desktop.shelf-items")
    static func stem(_ text:String)->String {
        let line=text.split(whereSeparator:\.isNewline).first.map(String.init) ?? "Text"
        let valid=line.components(separatedBy:CharacterSet(charactersIn:"/:\0").union(.controlCharacters)).joined(separator:" ")
        let clean=String(valid.trimmingCharacters(in:.whitespacesAndNewlines).prefix(40))
        return clean.isEmpty ? "Text":clean
    }
    static func read(_ board:NSPasteboard)throws->[ShelfPayload] {
        let change=board.changeCount
        guard let items=board.pasteboardItems,!items.isEmpty,items.count<=128,items.allSatisfy({AssistPrivacy.concealed.isDisjoint(with:$0.types)}) else{throw ShelfFailure.empty}
        var total=0
        let payloads=try items.map{ i -> ShelfPayload in
            if let raw=i.string(forType:.fileURL),let u=URL(string:raw),u.isFileURL{return .reference(u)}
            if let raw=i.string(forType:.URL),let u=URL(string:raw),["https","http","mailto"].contains(u.scheme?.lowercased() ?? "") {
                return .bytes(stem(u.host ?? "Link")+".txt",.link,Data(raw.utf8))
            }
            if let type=i.availableType(from:[.png,.tiff,.init("public.jpeg"),.init("public.heic")]),let d=i.data(forType:type) {
                total+=d.count;guard total<=128*1024*1024,CGImageSourceCreateWithData(d as CFData,nil) != nil else{throw ShelfFailure.quota}
                let ext=UTType(type.rawValue)?.preferredFilenameExtension ?? "png";return .bytes("Image."+ext,.image,d)
            }
            if let d=i.data(forType:.rtf) {
                total+=d.count;guard total<=16*1024*1024 else{throw ShelfFailure.quota}
                let title=stem(NSAttributedString(rtf:d,documentAttributes:nil)?.string ?? "Text");return .bytes(title+".rtf",.rich,d)
            }
            let text=i.string(forType:.string) ?? i.string(forType:.html).map(PocketStore.plainTextFromHTML)
            guard let text,!text.isEmpty else{throw ShelfFailure.empty};total+=text.utf8.count;guard total<=16*1024*1024 else{throw ShelfFailure.quota}
            return .bytes(stem(text)+".txt",PocketStore.isSupportedLink(text) ? .link:.text,Data(text.utf8))
        }
        guard board.changeCount==change else{throw ShelfFailure.changed};return payloads
    }
    static func writer(_ item:ShelfItem,url:URL,token:String?=nil,filesOnly:Bool=false)throws->NSPasteboardItem {
        let writer=NSPasteboardItem()
        writer.setString(url.absoluteString,forType:.fileURL)
        if let token {writer.setString(token+":"+item.id.uuidString,forType:reorder)}
        if filesOnly {return writer}
        switch item.kind {
        case .text,.rich,.link:
            let text=try ShelfProcessing.plain(.init(item:item,url:url),limit:2_000_000)
            writer.setString(text,forType:.string)
            if item.kind == .link {writer.setString(text,forType:.URL)}
            if item.kind == .rich {writer.setData(try Data(contentsOf:url,options:.mappedIfSafe),forType:.rtf)}
        case .image:
            if item.asset != nil, item.bytes<=12*1024*1024,let type=UTType(filenameExtension:url.pathExtension) {
                writer.setData(try Data(contentsOf:url,options:.mappedIfSafe),forType:.init(type.identifier))
            }
        default:break
        }
        return writer
    }
}
