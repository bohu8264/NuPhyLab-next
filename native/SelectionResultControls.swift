import SwiftUI

struct SelectionPanelButton: View {
    let symbol: String
    let title: String
    let hovering: Bool
    let action: () -> Void

    var body: some View {
        Button(action:action) {
            Image(systemName:symbol).font(.system(size:12))
                .frame(width:24,height:24).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(Color(white:hovering ? 0.8 : 0.57))
        .help(title).accessibilityLabel(title)
    }
}

// Both result panels use the same symbols, hit targets and keyboard reading order.
struct SelectionResultActions: View {
    let hovering: Bool
    let expanded: Bool
    let copied: Bool
    let copyTitle: String
    let questionTitle: String
    let sizeTitle: String
    let closeTitle: String
    var copy: (() -> Void)?
    var ask: (() -> Void)?
    var changeSize: (() -> Void)?
    let close: () -> Void

    var body: some View {
        HStack(spacing:2) {
            if let changeSize {
                SelectionPanelButton(symbol:copied ? "checkmark" : "doc.on.doc",title:copyTitle,hovering:hovering) { copy?() }
                    .disabled(copy == nil)
                SelectionPanelButton(symbol:"text.bubble",title:questionTitle,hovering:hovering) { ask?() }
                    .disabled(ask == nil)
                SelectionPanelButton(symbol:expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                                     title:sizeTitle,hovering:hovering,action:changeSize)
            }
            SelectionPanelButton(symbol:"xmark",title:closeTitle,hovering:hovering,action:close)
        }
    }
}

struct SelectionQuestionField: View {
    @Binding var text: String
    let focus: FocusState<Bool>.Binding
    let placeholder: String
    let sendTitle: String
    let busy: Bool
    let submit: () -> Void
    private var canSubmit: Bool { !busy && !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment:.bottom,spacing:8) {
            TextField(placeholder,text:$text,axis:.vertical).lineLimit(1...4)
                .textFieldStyle(.plain).font(.system(size:13)).focused(focus)
                .accessibilityLabel(placeholder)
                .onSubmit { if canSubmit { submit() } }
            Button(action:submit) {
                Image(systemName:"arrow.up").font(.system(size:11,weight:.semibold)).frame(width:24,height:24)
                    .background(Color(white:0.86),in:Circle()).foregroundStyle(.black)
            }
            .buttonStyle(.plain).disabled(!canSubmit).help(sendTitle).accessibilityLabel(sendTitle)
        }
        .padding(10).background(Color(white:0.09),in:RoundedRectangle(cornerRadius:12))
    }
}
