import Foundation
import Capacitor
import Security

/// Keychain-backed string store for API keys / tokens.
/// JS name: Capacitor.Plugins.LuminaSecureStore
@objc(LuminaSecureStorePlugin)
public class LuminaSecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LuminaSecureStorePlugin"
    public let jsName = "LuminaSecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    private let service = "com.lumina.todo.secure"

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key required")
            return
        }
        do {
            let value = try readKeychain(key: key)
            call.resolve(["value": value as Any])
        } catch {
            call.reject("keychain get failed: \(error.localizedDescription)")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key required")
            return
        }
        let value = call.getString("value") ?? ""
        do {
            try writeKeychain(key: key, value: value)
            call.resolve()
        } catch {
            call.reject("keychain set failed: \(error.localizedDescription)")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key required")
            return
        }
        do {
            try deleteKeychain(key: key)
            call.resolve()
        } catch {
            call.reject("keychain remove failed: \(error.localizedDescription)")
        }
    }

    private func account(_ key: String) -> String {
        return "lumina." + key
    }

    private func readKeychain(key: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(key),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw NSError(domain: "LuminaSecureStore", code: Int(status), userInfo: [
                NSLocalizedDescriptionKey: "SecItemCopyMatching \(status)",
            ])
        }
        guard let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func writeKeychain(key: String, value: String) throws {
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(key),
        ]
        let updates: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(base as CFDictionary, updates as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw NSError(domain: "LuminaSecureStore", code: Int(updateStatus), userInfo: [
                NSLocalizedDescriptionKey: "SecItemUpdate \(updateStatus)",
            ])
        }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: "LuminaSecureStore", code: Int(status), userInfo: [
                NSLocalizedDescriptionKey: "SecItemAdd \(status)",
            ])
        }
    }

    private func deleteKeychain(key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(key),
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            return
        }
        throw NSError(domain: "LuminaSecureStore", code: Int(status), userInfo: [
            NSLocalizedDescriptionKey: "SecItemDelete \(status)",
        ])
    }
}
