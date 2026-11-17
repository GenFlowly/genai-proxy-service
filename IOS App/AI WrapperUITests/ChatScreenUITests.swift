import XCTest

/// The phone chat screen on the canned `--mock-conversation`: one turn with two responses,
/// no sign-in and no backend calls.
final class ChatScreenUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
        // The launch tests leave the device in whatever configuration they ran last.
        XCUIDevice.shared.orientation = .portrait
    }

    @MainActor
    private func launchMockConversation() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--mock-conversation", "--ui-testing"]
        app.launch()
        return app
    }

    private func element(_ query: XCUIElementQuery, labelled text: String) -> XCUIElement {
        query.matching(NSPredicate(format: "label == %@", text)).firstMatch
    }

    @MainActor
    func testTheTitleOpensTheOutlineAndPickingATurnClosesIt() throws {
        let app = launchMockConversation()
        let title = app.buttons["mobile-header-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertEqual(title.label, "Outline: Sorting algorithms compared")
        title.tap()

        let close = app.buttons["outline-sheet-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertTrue(element(app.staticTexts, labelled: "1 turn").exists)
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "outline-row-"))
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows.firstMatch.isSelected)

        rows.firstMatch.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
    }

    @MainActor
    func testTheCloseButtonDismissesTheOutline() throws {
        let app = launchMockConversation()
        let title = app.buttons["mobile-header-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        title.tap()

        let close = app.buttons["outline-sheet-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
        XCTAssertTrue(title.isHittable)
    }

    @MainActor
    func testTypingAFollowUpKeepsTheEditorAboveTheKeyboard() throws {
        let app = launchMockConversation()
        XCTAssertTrue(app.buttons["More actions"].waitForExistence(timeout: 10))
        for _ in 0..<4 { app.swipeUp() }

        let editor = element(app.textViews, labelled: "Generate")
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText("Make it shorter")

        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let send = element(app.buttons, labelled: "Generate")
        let deadline = Date().addingTimeInterval(3)
        while send.frame.maxY > keyboard.frame.minY, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertLessThanOrEqual(editor.frame.maxY, keyboard.frame.minY)
        XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY)
    }

    @MainActor
    func testALongFollowUpGrowsTheEditorUpToTheHeaderThenScrolls() throws {
        let app = launchMockConversation()
        let title = app.buttons["mobile-header-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        for _ in 0..<4 { app.swipeUp() }

        let editor = element(app.textViews, labelled: "Generate")
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText("Line 1")
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let resting = editor.frame.height

        func settle(_ done: () -> Bool) {
            let deadline = Date().addingTimeInterval(3)
            while !done(), Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        }

        editor.typeText(String(repeating: "\nMore", count: 8))
        settle { editor.frame.height > resting }
        XCTAssertGreaterThan(editor.frame.height, resting)
        settle { editor.frame.maxY <= keyboard.frame.minY }
        XCTAssertLessThanOrEqual(editor.frame.maxY, keyboard.frame.minY)

        editor.typeText(String(repeating: "\nMore", count: 30))
        Thread.sleep(forTimeInterval: 1)
        let tallest = editor.frame.height
        XCTAssertGreaterThanOrEqual(editor.frame.minY, title.frame.maxY)
        XCTAssertLessThanOrEqual(editor.frame.maxY, keyboard.frame.minY)
        let atTheCap = XCTAttachment(screenshot: app.screenshot())
        atTheCap.name = "long-follow-up-at-the-cap"
        atTheCap.lifetime = .keepAlways
        add(atTheCap)

        editor.typeText(String(repeating: "\nMore", count: 4))
        Thread.sleep(forTimeInterval: 1)
        XCTAssertEqual(editor.frame.height, tallest, accuracy: 1)
    }

    @MainActor
    func testThePromptsCopyButtonSaysItCopiesThePrompt() throws {
        let app = launchMockConversation()
        XCTAssertTrue(app.buttons["More actions"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "Copy Prompt")).count, 1)
    }

    @MainActor
    func testTheKebabOpensAISettingsWithTheThreeCards() throws {
        let app = launchMockConversation()
        let more = app.buttons["More actions"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        more.tap()

        let aiSettings = element(app.buttons, labelled: "AI Settings")
        XCTAssertTrue(aiSettings.waitForExistence(timeout: 5))
        XCTAssertFalse(element(app.buttons, labelled: "AI Config").exists)
        aiSettings.tap()

        for card in ["Models", "Agent", "Tokens"] {
            XCTAssertTrue(element(app.staticTexts, labelled: card).waitForExistence(timeout: 5), card)
        }
        let closeSettings = element(app.buttons, labelled: "Close Settings")
        XCTAssertTrue(closeSettings.exists)
        closeSettings.tap()
        XCTAssertTrue(closeSettings.waitForNonExistence(timeout: 5))
    }

    @MainActor
    func testTheProjectHintStaysClearOfTheEditorWithTheKeyboardOpen() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--mock-project-chat", "--ui-testing"]
        app.launch()
        let header = app.buttons["mobile-header-project"]
        let hint = app.staticTexts["new-chat-project-hint"]
        XCTAssertTrue(hint.waitForExistence(timeout: 10))

        let editor = element(app.textViews, labelled: "Generate")
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(hint.frame.maxY, editor.frame.minY)

        editor.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let deadline = Date().addingTimeInterval(3)
        while editor.frame.maxY > keyboard.frame.minY, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        // A simulator with a hardware keyboard keeps the software one off screen, which tests nothing
        XCTAssertLessThan(keyboard.frame.minY, app.windows.firstMatch.frame.maxY, "the software keyboard is hidden")
        let withKeyboard = XCTAttachment(screenshot: app.screenshot())
        withKeyboard.name = "project-hint-with-keyboard"
        withKeyboard.lifetime = .keepAlways
        add(withKeyboard)
        XCTAssertTrue(hint.exists)
        XCTAssertGreaterThanOrEqual(hint.frame.minY, header.frame.maxY)
        XCTAssertLessThanOrEqual(hint.frame.maxY, editor.frame.minY)
    }
}
