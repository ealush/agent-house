import SwiftUI
import UIKit

/// Pairing this device with a host: its tailnet address, a one-time setup code from a device
/// that's already signed in, and a name. The device's key is made here (Secure Enclave) and
/// only its public half leaves; nothing is trusted from the network until the host verifies
/// the code and the signature.
struct SetupView: View {
    let app: AppModel
    let done: (AccountSession) -> Void
    @State private var address = ""
    @State private var code = ""
    @State private var label = UIDevice.current.name
    @State private var busy = false
    @State private var error: String?
    @FocusState private var field: Field?
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    enum Field { case address, code, label }

    /// Pairing again with a host that removed this device: its address is already known.
    private func prefill() {
        guard address.isEmpty, let known = app.pairAgainAddress else { return }
        address = known
        app.pairAgainAddress = nil
        field = .code
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 14) {
                        Image("AppMark")
                            .resizable()
                            .frame(width: 88, height: 88)
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .shadow(color: theme.brand.opacity(0.35), radius: 18, y: 8)
                            .accessibilityHidden(true)
                        Text("Connect to Agent Hub").font(.ah(.title).weight(.bold))
                        Text("Your host stays private on your tailnet. This device gets its own key, which you can remove from any other device.")
                            .font(.ah(.callout))
                            .foregroundStyle(theme.muted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .listRowBackground(Color.clear)
                }
                Section {
                    TextField("https://your-host.your-tailnet.ts.net", text: $address)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($field, equals: .address)
                        .submitLabel(.next)
                        .onSubmit { field = .code }
                        .accessibilityIdentifier("hostAddress")
                } header: {
                    Text("Host address")
                } footer: {
                    Text("The HTTPS address Tailscale Serve gives Agent Hub.")
                }
                Section {
                    TextField("Setup code", text: $code)
                        .font(.ahMono(.title3))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .textContentType(.oneTimeCode)
                        .focused($field, equals: .code)
                        .submitLabel(.next)
                        .onSubmit { field = .label }
                        .accessibilityIdentifier("setupCode")
                } header: {
                    Text("Setup code")
                } footer: {
                    Text("On a device that’s already signed in: Settings → Security → Issue a setup code. On the host itself: `ah auth code`.")
                }
                Section("This device’s name") {
                    TextField("Name", text: $label)
                        .focused($field, equals: .label)
                        .submitLabel(.go)
                        .onSubmit { Task { await enroll() } }
                        .accessibilityIdentifier("deviceLabel")
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(theme.danger)
                            .accessibilityIdentifier("setupError")
                    }
                }
                Section {
                    Button {
                        Task { await enroll() }
                    } label: {
                        Group {
                            if busy { ProgressView().tint(.white) } else { Text("Connect").fontWeight(.semibold) }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                    .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty || code.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("connectHost")
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
            }
            // A comfortable column on a big screen, not a form across the whole iPad.
            .frame(maxWidth: 600)
            .frame(maxWidth: .infinity)
            .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
            .navigationTitle(app.accounts.isEmpty ? "" : "Add a host")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !app.accounts.isEmpty {
                    ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction) }
                }
            }
            .onAppear {
                field = .address
                prefill()
            }
        }
        .interactiveDismissDisabled(app.accounts.isEmpty || busy)
    }

    private func enroll() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let session = try await app.enroll(address: address.trimmingCharacters(in: .whitespaces), code: code.trimmingCharacters(in: .whitespaces), label: label)
            Haptics.success()
            await PushRegistrar.shared.registerIfAuthorized()
            done(session)
        } catch {
            Haptics.failure()
            self.error = (error as? LocalizedError)?.errorDescription ?? APIError.wrap(error).message
        }
    }
}

/// An enrolled host whose sign-in ended (locked, expired, or ended from another device):
/// Face ID unlocks the device key, which signs a fresh challenge.
struct SignInView: View {
    let account: AccountSession
    let app: AppModel
    /// Forget this host here and open Setup on its address (a removed device).
    let pairAgain: () -> Void
    @Environment(\.theme) private var theme
    @State private var confirmForget = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "lock.shield").font(.system(size: 56)).foregroundStyle(theme.brand)
            Text(account.hostname).font(.ah(.title2).weight(.semibold))
            Text(account.origin).font(.ahMono(.footnote)).foregroundStyle(theme.muted)
            switch account.status {
            case .needsSignIn(let reason):
                if let reason { Text(reason).font(.ah(.callout)).foregroundStyle(theme.muted).multilineTextAlignment(.center) }
                Button {
                    Task { await account.signIn() }
                } label: {
                    Label("Sign in", systemImage: "faceid").frame(maxWidth: 280)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(theme.accentStrong)
                .keyboardShortcut(.defaultAction)
            case .signingIn:
                ProgressView("Signing in…")
            case .unenrolled(let reason):
                Text(reason).font(.ah(.callout)).foregroundStyle(theme.muted).multilineTextAlignment(.center)
                Button(action: pairAgain) {
                    Label("Pair Again", systemImage: "link").frame(maxWidth: 280)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(theme.accentStrong)
                .keyboardShortcut(.defaultAction)
                Text("You’ll need a setup code from a device that’s still signed in, or `ah auth code` on the host.")
                    .font(.ah(.footnote))
                    .foregroundStyle(theme.faint)
                    .multilineTextAlignment(.center)
            case .signedIn:
                ProgressView()
            }
            Spacer()
            if case .needsSignIn = account.status {
                Button("Forget this host on this device…", role: .destructive) { confirmForget = true }.font(.ah(.footnote))
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background)
        .confirmationDialog("Forget \(account.hostname)?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget", role: .destructive) { Task { await app.removeLocally(account) } }
        } message: {
            Text("This device’s key is deleted. The host still lists it until you remove it there.")
        }
        .task {
            // Arriving locked from launch: ask for Face ID straight away, once.
            if case .needsSignIn(nil) = account.status { await account.signIn() }
        }
    }
}
