import SwiftUI

/// LaunchScreen.storyboard redrawn from the same assets and frames, so the handoff from the launch
/// screen doesn't move; ContentView fades it out (web: #splash in public/index.html). Both stretch
/// the square gradient, which is what the web's `linear-gradient(to bottom right, …)` draws.
struct SplashView: View {
    var body: some View {
        ZStack {
            Image("SplashBackground")
                .resizable()
            Image("SplashMark")
                .resizable()
                .frame(width: 104, height: 96)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
