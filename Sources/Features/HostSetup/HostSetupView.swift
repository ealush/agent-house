import SwiftUI

struct HostSetupView: View {
    @Bindable var model: HostSetupModel

    var body: some View {
        Form {
            Section {
                Label("Your agents, on your devices", systemImage: "terminal")
                    .font(.headline)
                Text("Agent Hub connects to the sessions running on your own host.")
                    .foregroundStyle(.secondary)
            }
            Section("Host address") {
                TextField("https://machine.tailnet.ts.net", text: $model.address)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Host address")
                    .accessibilityIdentifier("hostAddress")
                Button("Save host address") {
                    Task { await model.saveAddress() }
                }
                .disabled(model.isRestoring || model.isSaving)
                .accessibilityIdentifier("saveHostAddress")
            }
            .disabled(model.isRestoring)
            if let error = model.error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("setupError")
                }
            }
            if let notice = model.notice {
                Section {
                    Label(notice, systemImage: "checkmark.circle")
                        .accessibilityIdentifier("setupNotice")
                }
            }
            Section {
                Text("Pairing is coming next. Saving an address doesn’t connect to your host or sign you in.")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

