import SwiftUI

/// A phone's Search tab: every session and History, then what was said (`SearchResults`), as
/// the Inbox's search shows them on an iPad. Its field stands on the keyboard at the screen's
/// foot (`SearchTabController`), which writes what's typed to the scene's query; this page keeps
/// its model to it, narrowed to the Inbox's chosen Space.
struct SearchPage: View {
    @Bindable var scene: SceneModel
    /// The list touched: the field gives the keyboard back (SwiftUI's own dismissal
    /// on scroll knows only its own fields).
    var onScroll: () -> Void = {}
    @State private var search: SearchModel?
    @Environment(\.theme) private var theme

    var body: some View {
        Group {
            if let hub = scene.hub {
                if let search { SearchList(scene: scene, hub: hub, search: search, onScroll: onScroll) } else { Color.clear.onAppear { search = SearchModel(api: hub.api) } }
            } else {
                ProgressView()
            }
        }
        .scrollContentBackground(.hidden)
        .background(theme.background.ignoresSafeArea())
    }
}

private struct SearchList: View {
    @Bindable var scene: SceneModel
    let hub: HubStore
    @Bindable var search: SearchModel
    let onScroll: () -> Void

    var body: some View {
        let project = scene.shownInboxProject
        // Only a phone's: an iPad's search is the Inbox's.
        let phone = scene.narrow
        List {
            // Its title in the page, as the Inbox's and Review's are, with no bar over it.
            Section { } header: {
                AhLargeTitle(title: "Search", tagline: project.map { $0.isOutside ? "\($0.title)." : "In \($0.title)." } ?? "Sessions, History and what was said, on every host.").textCase(nil)
            }
            SearchResults(scene: scene, model: search, project: project)
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(12)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .onScrollPhaseChange { _, phase in if phase == .interacting { onScroll() } }
        .refreshable { await hub.resyncAndWait() }
        .onChange(of: search.query) { _, query in
            guard phone else { return }
            let term = hub.searchTerm(project)
            if query.project != term { search.query.project = term; return }
            if scene.search != query { scene.search = query }
            scene.scheduleSave()
            search.search()
        }
        .onChange(of: project, initial: true) { _, project in
            let term = hub.searchTerm(project)
            if search.query.project != term { search.query.project = term }
        }
        // What's typed in the field, a filter set elsewhere, or "See all results for …"
        // from the switcher.
        .onChange(of: scene.search, initial: true) { _, asked in
            if let asked, asked != search.query { search.query = asked }
        }
        // A window narrowed into the phone's layout: the search here, as the Inbox left it.
        .onChange(of: phone) { _, phone in
            guard phone else { return }
            if let saved = scene.search, saved != search.query { search.query = saved } else { search.search() }
        }
    }
}
