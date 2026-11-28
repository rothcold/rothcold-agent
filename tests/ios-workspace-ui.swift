import XCTest

@MainActor
final class IOSWorkspaceUITests: XCTestCase {
    func testVerifiedWorkspaceRestoreAndFilePreview() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        let address = try XCTUnwrap(environment["IOS_NOISE_TEST_ADDRESS"])
        let pin = try XCTUnwrap(environment["IOS_NOISE_TEST_PIN"])
        let owner = try XCTUnwrap(environment["IOS_NOISE_TEST_OWNER"])
        let app = XCUIApplication()
        app.launch()

        let addressField = app.textFields["serverAddress"]
        XCTAssertTrue(addressField.waitForExistence(timeout: 10))
        addressField.tap()
        addressField.typeText(address)
        let pinField = app.descendants(matching: .any)["serverPin"].firstMatch
        pinField.tap()
        pinField.typeText(pin)
        tap(app.buttons["Verify and connect"], in: app)
        XCTAssertTrue(app.staticTexts["Noise server identity verified."].waitForExistence(timeout: 10))
        capture("01-pin-verified", app: app)
        let label = app.textFields["Device name"]
        label.tap()
        label.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6) + "Simulator Flow")
        let credential = app.secureTextFields["Owner token"]
        credential.tap()
        credential.typeText(owner)
        tap(app.buttons["Sign in"], in: app)
        XCTAssertTrue(app.staticTexts["Workspace"].waitForExistence(timeout: 10))
        capture("02-workspace", app: app)

        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["Workspace"].waitForExistence(timeout: 10), "device-only Keychain restore")
        tap(app.buttons["Inbox"], in: app)
        XCTAssertTrue(app.staticTexts["Inbox"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Simulator final reply")).firstMatch.exists)
        capture("03-inbox", app: app)
        tap(app.buttons.containing(.staticText, identifier: "Received files").firstMatch, in: app)
        XCTAssertTrue(app.staticTexts["finalReply"].waitForExistence(timeout: 10))
        capture("04-conversation", app: app)

        let svg = app.buttons["Open download-only.svg"]
        tap(svg, in: app)
        XCTAssertTrue(app.staticTexts["Download only. This file won’t be previewed."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.images["Image preview"].exists)
        capture("05-download-only", app: app)
        tap(app.buttons["Done"], in: app)
        saveBinary(app)
        sendReplyAndAttachment(app)
        startThread(app)

        tap(app.buttons["Settings"], in: app)
        tap(app.buttons["View owner avatar"], in: app)
        XCTAssertTrue(app.images["Image preview"].waitForExistence(timeout: 10))
        capture("08-avatar", app: app)
        tap(app.buttons["Done"], in: app)
        tap(app.buttons["Sign out this device"], in: app)
        tap(app.buttons["Sign out"], in: app)
        XCTAssertTrue(app.staticTexts["Reconnect"].waitForExistence(timeout: 10))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["Sign in"].waitForExistence(timeout: 10), "logout removes local device credential")
    }

    func testVerifiedWorkspaceRevocationAndReconnect() async throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        try XCTSkipUnless(env["IOS_NOISE_TEST_CONTROL"] != nil, "Requires the disposable reconnect fixture")
        let control = try XCTUnwrap(env["IOS_NOISE_TEST_CONTROL"].flatMap(URL.init(string:)))
        let address = try XCTUnwrap(env["IOS_NOISE_TEST_ADDRESS"])
        let alias = try XCTUnwrap(env["IOS_NOISE_TEST_ALIAS"])
        let pin = try XCTUnwrap(env["IOS_NOISE_TEST_PIN"])
        let owner = try XCTUnwrap(env["IOS_NOISE_TEST_OWNER"])
        let app = XCUIApplication()
        app.launch()
        selectServer(app, address: address, pin: pin)
        enroll(app, owner: owner, label: "Simulator Live Revocation")
        _ = try await fixture(control, "original-device")
        try await verifyEndpointScope(app, control: control, address: address, alias: alias, pin: pin)
        try await recoverInterruptedSend(app, control: control)
        try await verifyRevokedSend(app, control: control)
        try await verifyLiveRevocation(app, control: control, owner: owner)
        try await verifyColdRevocation(app, control: control, owner: owner)
        try await verifyPinScope(app, control: control, address: address, owner: owner)
    }

    private func verifyEndpointScope(_ app: XCUIApplication, control: URL, address: String, alias: String, pin: String) async throws {
        tap(app.buttons["Settings"], in: app)
        tap(app.buttons["Change server"], in: app)
        selectServer(app, address: alias, pin: pin)
        XCTAssertTrue(app.secureTextFields["Owner token"].waitForExistence(timeout: 10))
        _ = try await fixture(control, "alias-request-scope")
        tap(app.buttons["Change server"], in: app)
        selectServer(app, address: address, pin: pin)
        XCTAssertTrue(app.staticTexts["Workspace"].waitForExistence(timeout: 10))
        _ = try await fixture(control, "original-device")
    }

    private func recoverInterruptedSend(_ app: XCUIApplication, control: URL) async throws {
        tap(app.buttons["Inbox"], in: app)
        tap(app.buttons.containing(.staticText, identifier: "Received files").firstMatch, in: app)
        let draft = "Keep this exact ordinary draft after losing the send receipt"
        let editor = app.textViews["messageEditor"]
        tap(editor, in: app)
        editor.typeText(draft)
        tap(app.buttons["Dismiss keyboard"], in: app)
        _ = try await fixture(control, "arm")
        tap(app.buttons["Send reply"], in: app)
        XCTAssertTrue(app.staticTexts["Reconnect"].waitForExistence(timeout: 10))
        tap(app.buttons["Verify and reconnect"], in: app)
        XCTAssertTrue(app.buttons["Retry same send"].waitForExistence(timeout: 10))
        XCTAssertEqual(editor.value as? String, draft)
        _ = try await fixture(control, "original-device")
        _ = try await fixture(control, "no-replay")
        capture("11-draft-recovered", app: app)
        let retry = app.buttons["Retry same send"]
        tap(retry, in: app)
        XCTAssertTrue(retry.waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["turnState-queued"].waitForExistence(timeout: 10))
        _ = try await fixture(control, "explicit-retry")
    }

    private func verifyRevokedSend(_ app: XCUIApplication, control: URL) async throws {
        let editor = app.textViews["messageEditor"]
        tap(editor, in: app)
        editor.typeText("This draft must never be queued after a peer revokes this device")
        tap(app.buttons["Dismiss keyboard"], in: app)
        _ = try await fixture(control, "revoke-before-send")
        tap(app.buttons["Send reply"], in: app)
        expectAuthorizationRejected(app)
        _ = try await fixture(control, "send-rejected")
    }

    private func verifyLiveRevocation(_ app: XCUIApplication, control: URL, owner: String) async throws {
        tap(app.buttons["Verify and reconnect"], in: app)
        enroll(app, owner: owner, label: "Simulator Media Revocation")
        tap(app.buttons["Settings"], in: app)
        tap(app.buttons["View owner avatar"], in: app)
        XCTAssertTrue(app.images["Image preview"].waitForExistence(timeout: 10))
        _ = try await fixture(control, "present-media")
        _ = try await fixture(control, "revoke-live-media")
        expectAuthorizationRejected(app)
        XCTAssertTrue(app.images["Image preview"].waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Save to Files"].exists)
        _ = try await fixture(control, "discarded-media")
        capture("12-live-revocation", app: app)
    }

    private func expectAuthorizationRejected(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["Reconnect"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["workspaceMessage"].label.contains("no longer valid"), "Expected a typed authorization rejection, not a generic disconnect")
        XCTAssertFalse(app.buttons["Settings"].exists)
    }

    private func verifyColdRevocation(_ app: XCUIApplication, control: URL, owner: String) async throws {
        tap(app.buttons["Verify and reconnect"], in: app)
        enroll(app, owner: owner, label: "Simulator Cold Revocation")
        app.terminate() // The app cannot learn about this revocation or remove the stale credential yet.
        _ = try await fixture(control, "revoke-cold")
        app.launch()
        XCTAssertTrue(app.secureTextFields["Owner token"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["workspaceMessage"].label.contains("no longer valid"))
        XCTAssertFalse(app.buttons["Settings"].exists)
        capture("13-revoked-cold-sign-in", app: app)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.secureTextFields["Owner token"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["workspaceMessage"].exists, "The rejected Keychain credential was removed")
    }

    private func verifyPinScope(_ app: XCUIApplication, control: URL, address: String, owner: String) async throws {
        enroll(app, owner: owner, label: "Simulator Pin Scope")
        tap(app.buttons["Settings"], in: app)
        tap(app.buttons["Change server"], in: app)
        let replacement = try JSONDecoder().decode(String.self, from: try await fixture(control, "rotate"))
        tap(app.buttons["Verify and connect"], in: app) // Existing pin must fail at the unchanged endpoint.
        XCTAssertTrue(app.staticTexts["Reconnect"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.secureTextFields["Owner token"].exists)
        tap(app.buttons["Change server"], in: app)
        _ = try await fixture(control, "reset-frames")
        selectServer(app, address: address, pin: replacement)
        XCTAssertTrue(app.secureTextFields["Owner token"].waitForExistence(timeout: 10))
        _ = try await fixture(control, "rotated-request-scope")
        capture("14-replacement-pin", app: app)
    }

    private func enroll(_ app: XCUIApplication, owner: String, label: String) {
        let token = app.secureTextFields["Owner token"]
        XCTAssertTrue(token.waitForExistence(timeout: 10))
        replace(app.textFields["Device name"], with: label)
        token.tap()
        token.typeText(owner)
        tap(app.buttons["Sign in"], in: app)
        XCTAssertTrue(app.staticTexts["Workspace"].waitForExistence(timeout: 10))
    }

    private func selectServer(_ app: XCUIApplication, address: String, pin: String) {
        let field = app.textFields["serverAddress"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        replace(field, with: address)
        let pinField = app.descendants(matching: .any)["serverPin"].firstMatch
        if pinField.value as? String != pin {
            let clear = app.buttons["Clear pin"]
            if clear.exists { tap(clear, in: app) }
            pinField.tap()
            pinField.typeText(pin)
            XCTAssertEqual(pinField.value as? String, pin)
        }
        tap(app.buttons["Verify and connect"], in: app)
    }

    private func replace(_ field: XCUIElement, with value: String) {
        if field.value as? String == value { return }
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.5)).tap()
        let old = field.value as? String
        let count = old == field.placeholderValue ? 0 : old?.count ?? 0
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: count) + value)
        XCTAssertEqual(field.value as? String, value)
    }

    private func fixture(_ endpoint: URL, _ action: String) async throws -> Data {
        var request = URLRequest(url: endpoint.appending(path: action), timeoutInterval: 15)
        request.httpMethod = "POST"
        let (bytes, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(decoding: bytes, as: UTF8.self))
        return bytes
    }

    private func saveBinary(_ app: XCUIApplication) {
        tap(app.buttons["Open ios-cross-client.bin"], in: app)
        XCTAssertTrue(app.staticTexts["ios-cross-client.bin"].waitForExistence(timeout: 10))
        tap(app.buttons["Save to Files"], in: app)
        let save = app.buttons["Save"].firstMatch
        XCTAssertTrue(save.waitForExistence(timeout: 10))
        if !save.isEnabled {
            tap(app.buttons["On My iPhone"].firstMatch, in: app)
        }
        capture("06-system-save", app: app)
        tap(save, in: app)
        tap(app.buttons["Done"], in: app)
    }

    private func sendReplyAndAttachment(_ app: XCUIApplication) {
        let editor = app.textViews["messageEditor"]
        tap(editor, in: app)
        editor.typeText("Queued from iPhone simulator")
        capture("10-typing", app: app)
        tap(app.buttons["Dismiss keyboard"], in: app)
        tap(app.buttons["Attach files"], in: app)
        let imported = app.staticTexts["ios-cross-client.bin"].firstMatch
        XCTAssertTrue(imported.waitForExistence(timeout: 10))
        tap(imported, in: app)
        if app.buttons["Open"].firstMatch.waitForExistence(timeout: 2) { tap(app.buttons["Open"].firstMatch, in: app) }
        XCTAssertTrue(app.buttons["Remove ios-cross-client.bin"].waitForExistence(timeout: 10))
        tap(app.buttons["Send reply"], in: app)
        XCTAssertTrue(app.staticTexts["turnState-queued"].waitForExistence(timeout: 10))
        capture("07-queued-reply-with-file", app: app)
    }

    private func startThread(_ app: XCUIApplication) {
        tap(app.buttons["Workspace directory"], in: app)
        tap(app.buttons["General"], in: app)
        let editor = app.textViews["messageEditor"]
        tap(editor, in: app)
        editor.typeText("New iPhone simulator thread")
        tap(app.buttons["Dismiss keyboard"], in: app)
        tap(app.buttons["Start thread"], in: app)
        XCTAssertTrue(app.staticTexts["turnState-queued"].waitForExistence(timeout: 10))
        capture("09-new-thread", app: app)
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func tap(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for index in 0..<7 {
            if element.exists && element.isHittable && element.isEnabled {
                element.tap()
                return
            }
            if index == 0 { _ = element.waitForExistence(timeout: 3) }
            if index > 1 { app.swipeUp(velocity: .slow) }
        }
        XCTAssertTrue(element.isHittable && element.isEnabled, "Control was not tappable: \(element)", file: file, line: line)
    }
}
