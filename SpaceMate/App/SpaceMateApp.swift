import SwiftUI

@main
struct SpaceMateApp: App {
    @State private var app = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(app.media)
                .environment(app.files)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var bindable = app
        TabView(selection: $bindable.selectedTab) {
            HomeView()
                .tabItem { Label("Home", systemImage: "internaldrive") }
                .tag(AppTab.home)
            MediaView()
                .tabItem { Label("Photos", systemImage: "photo.on.rectangle") }
                .tag(AppTab.media)
            FilesView()
                .tabItem { Label("Files", systemImage: "folder") }
                .tag(AppTab.files)
            PlannerView()
                .tabItem { Label("Plan", systemImage: "list.bullet.clipboard") }
                .tag(AppTab.plan)
            RoutineView()
                .tabItem { Label("Routine", systemImage: "calendar") }
                .tag(AppTab.routine)
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            if phase == .active {
                app.refreshStorage()
                app.media.refreshAccess()
            }
        }
    }
}
