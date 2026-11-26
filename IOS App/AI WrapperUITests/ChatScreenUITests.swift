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
        let title = app.buttons["mobile-header-pill"]
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
        let title = app.buttons["mobile-header-pill"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        title.tap()

        let close = app.buttons["outline-sheet-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
        XCTAssertTrue(title.isHittable)
    }

    /// Not scrolled: the idle follow-up editor rests on the bottom of the screen, over the
    /// response, and a tap there types into it.
    @MainActor
    func testTheIdleFollowUpEditorSticksToTheBottomAndTakesATap() throws {
        let app = launchMockConversation()
        XCTAssertTrue(app.buttons["More actions"].waitForExistence(timeout: 10))
        XCTAssertFalse(element(app.buttons, labelled: "Fork").isHittable)

        let prompt = element(app.buttons, labelled: "Copy Prompt")
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        let promptTop = prompt.frame.minY

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.87)).tap()
        app.typeText("Make it shorter")

        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let editor = element(app.textViews, labelled: "Generate")
        XCTAssertEqual(editor.value as? String, "Make it shorter")
        // The conversation stays where it was being read
        XCTAssertEqual(prompt.frame.minY, promptTop, accuracy: 1)
        let send = element(app.buttons, labelled: "Generate")
        let deadline = Date().addingTimeInterval(3)
        while send.frame.maxY > keyboard.frame.minY, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY)
    }

    @MainActor
    func testAShortConversationStillRestsTheEditorOnTheBottom() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--mock-short-conversation", "--ui-testing"]
        app.launch()
        XCTAssertTrue(element(app.buttons, labelled: "Fork").waitForExistence(timeout: 10))
        let resting = XCTAttachment(screenshot: app.screenshot())
        resting.name = "short-conversation-resting"
        resting.lifetime = .keepAlways
        add(resting)

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.87)).tap()
        app.typeText("Make it shorter")

        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        XCTAssertEqual(element(app.textViews, labelled: "Generate").value as? String, "Make it shorter")
        let send = element(app.buttons, labelled: "Generate")
        let deadline = Date().addingTimeInterval(3)
        while send.frame.maxY > keyboard.frame.minY, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        let typing = XCTAttachment(screenshot: app.screenshot())
        typing.name = "short-conversation-typing"
        typing.lifetime = .keepAlways
        add(typing)
        XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY)
    }

    @MainActor
    func testTheEditorStaysOnTheBottomWhileAResponseGenerates() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--mock-short-conversation", "--mock-generating", "--ui-testing"]
        app.launch()
        XCTAssertTrue(element(app.buttons, labelled: "Stop").waitForExistence(timeout: 10))
        let generating = XCTAttachment(screenshot: app.screenshot())
        generating.name = "editor-while-generating"
        generating.lifetime = .keepAlways
        add(generating)

        let editor = element(app.textViews, labelled: "Generate")
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.87)).tap()
        app.typeText("Next question")
        XCTAssertEqual(editor.value as? String, "Next question")
        XCTAssertFalse(element(app.buttons, labelled: "Generate").isEnabled)
    }

    @MainActor
    func testThePageFollowsTheThinkingThenGoesBackToTheResponse() throws {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("AI WrapperTests/ActivityFixtures/completed_six_searches.json")
        let app = XCUIApplication()
        app.launchArguments = ["-mockActivityReplay", fixture.path, "--ui-testing"]
        app.launch()
        let header = app.buttons["mobile-header-pill"]
        let editor = element(app.textViews, labelled: "Generate")
        let pendingAnswer = element(app.staticTexts, labelled: "Wrote the answer")
        let prompt = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Those three wedges")).firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 10))

        // The second search round runs 11-16 s in: the panel is taller than the page by then
        Thread.sleep(forTimeInterval: 14)
        let thinking = XCTAttachment(screenshot: app.screenshot())
        thinking.name = "following-the-thinking"
        thinking.lifetime = .keepAlways
        add(thinking)
        XCTAssertTrue(pendingAnswer.exists)
        XCTAssertGreaterThanOrEqual(pendingAnswer.frame.minY, header.frame.maxY)
        XCTAssertLessThanOrEqual(pendingAnswer.frame.maxY, editor.frame.minY)
        XCTAssertLessThan(prompt.frame.maxY, header.frame.maxY + 1)

        // The answer streams from 21 s: the panel folds and the page goes back to the response
        Thread.sleep(forTimeInterval: 9)
        let answering = XCTAttachment(screenshot: app.screenshot())
        answering.name = "back-at-the-response"
        answering.lifetime = .keepAlways
        add(answering)
        let model = element(app.staticTexts, labelled: "gpt-5.4-nano")
        XCTAssertFalse(pendingAnswer.exists)
        XCTAssertGreaterThanOrEqual(model.frame.minY, header.frame.maxY)
        XCTAssertLessThan(model.frame.minY, header.frame.maxY + 120)
    }

    @MainActor
    func testSwipingFromInsideALongResponseKeepsTheReadingPosition() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--mock-two-turns", "--ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["More actions"].waitForExistence(timeout: 10))
        let header = app.buttons["mobile-header-pill"]
        let outgoing = { app.staticTexts.matching(NSPredicate(format: "label == %@", "gpt-5.6-sol")).allElementsBoundByIndex.last }
        for _ in 0..<20 where (outgoing()?.frame.minY ?? 0) > header.frame.maxY {
            app.swipeUp(velocity: .slow)
        }
        let before = try XCTUnwrap(outgoing()).frame.minY
        XCTAssertLessThan(before, header.frame.maxY)

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.45)))

        let incoming = { app.staticTexts.matching(NSPredicate(format: "label == %@", "claude-fable-5")).allElementsBoundByIndex.last }
        XCTAssertTrue(try XCTUnwrap(incoming()).waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.5)
        let swiped = XCTAttachment(screenshot: app.screenshot())
        swiped.name = "swiped-keeps-the-reading-position"
        swiped.lifetime = .keepAlways
        add(swiped)
        // The incoming response starts where the outgoing one did: the page didn't move
        XCTAssertEqual(try XCTUnwrap(incoming()).frame.minY, before, accuracy: 4)
    }

    @MainActor
    func testSwipingPastTheEndOfAShorterResponseShowsItsEnd() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--mock-two-turns", "--ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["More actions"].waitForExistence(timeout: 10))
        for _ in 0..<8 { app.swipeUp() }
        let header = app.buttons["mobile-header-pill"]

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.45)))

        let incoming = { app.staticTexts.matching(NSPredicate(format: "label == %@", "claude-fable-5")).allElementsBoundByIndex.last }
        XCTAssertTrue(try XCTUnwrap(incoming()).waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.5)
        let swiped = XCTAttachment(screenshot: app.screenshot())
        swiped.name = "swiped-past-the-end-of-a-shorter-response"
        swiped.lifetime = .keepAlways
        add(swiped)
        // Its end sits above the editor; its start stays above the page, not brought to the top
        let regenerate = element(app.buttons, labelled: "Regenerate")
        let editor = element(app.textViews, labelled: "Generate")
        XCTAssertGreaterThanOrEqual(regenerate.frame.minY, header.frame.maxY)
        XCTAssertLessThanOrEqual(regenerate.frame.maxY, editor.frame.minY)
        XCTAssertLessThan(try XCTUnwrap(incoming()).frame.minY, header.frame.maxY)
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

    /// Typing in the follow-up editor at the end of the conversation; returns it at its full size.
    @MainActor
    private func typeFollowUp(_ text: String, in app: XCUIApplication) -> (editor: XCUIElement, inUse: CGFloat) {
        XCTAssertTrue(app.buttons["More actions"].waitForExistence(timeout: 10))
        for _ in 0..<4 { app.swipeUp() }
        let editor = element(app.textViews, labelled: "Generate")
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText(text)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let lines = CGFloat(text.split(separator: "\n", omittingEmptySubsequences: false).count)
        settle { editor.frame.height > 33.6 * (lines - 0.5) }
        return (editor, editor.frame.height)
    }

    private func settle(_ done: () -> Bool) {
        let deadline = Date().addingTimeInterval(3)
        while !done(), Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
    }

    /// On the response, between the header and the editor in use above the keyboard.
    @MainActor
    private func tapTheConversation(in app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.18)).tap()
    }

    /// A tap outside puts the editor away with its draft: back to one line, the draft kept.
    @MainActor
    func testATapOutsidePutsAFollowUpWithADraftAway() throws {
        let app = launchMockConversation()
        let (editor, inUse) = typeFollowUp("First line\nSecond line", in: app)

        tapTheConversation(in: app)
        settle { editor.frame.height < inUse }
        let putAway = XCTAttachment(screenshot: app.screenshot())
        putAway.name = "follow-up-put-away-by-a-tap"
        putAway.lifetime = .keepAlways
        add(putAway)
        XCTAssertEqual(editor.frame.height, 33.6, accuracy: 1)
        XCTAssertEqual(editor.value as? String, "First line\nSecond line")

        editor.tap()
        settle { editor.frame.height >= inUse }
        XCTAssertEqual(editor.frame.height, inUse, accuracy: 1)
    }

    /// Dragging the conversation back up puts the editor away too, even short of the keyboard.
    @MainActor
    func testDraggingTheConversationBackUpPutsTheEditorAway() throws {
        let app = launchMockConversation()
        let (editor, inUse) = typeFollowUp("Make it\nshorter\nplease", in: app)

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.32)))
        settle { editor.frame.height < inUse }
        XCTAssertEqual(editor.frame.height, 33.6, accuracy: 1)
        XCTAssertEqual(editor.value as? String, "Make it\nshorter\nplease")
    }

    /// Blank lines alone aren't kept: the put-away editor shows its placeholder again.
    @MainActor
    func testBlankLinesAloneAreDroppedWhenTheEditorIsPutAway() throws {
        let app = launchMockConversation()
        let (editor, _) = typeFollowUp(" \n\n ", in: app)

        tapTheConversation(in: app)
        settle { (editor.value as? String ?? "").isEmpty }
        XCTAssertEqual(editor.value as? String ?? "", "")
    }

    /// The box grows with its text up to half the space between the header and the keyboard, then
    /// the text scrolls inside it and the conversation keeps the other half.
    @MainActor
    func testALongFollowUpGrowsTheEditorToHalfTheSpaceThenScrolls() throws {
        let app = launchMockConversation()
        let title = app.buttons["mobile-header-pill"]
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
        // The box reaches 11 above its text and 61 below it (the gap and the controls row); the
        // conversation between the header and the box keeps at least as much room as the box.
        // (The keyboard element's frame starts below its suggestion strip, so it can't be the
        // reference.)
        let boxTop = editor.frame.minY - 11
        let boxHeight = editor.frame.maxY + 61 - boxTop
        XCTAssertGreaterThanOrEqual(boxTop - title.frame.maxY, boxHeight - 8)
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
        let header = app.descendants(matching: .any)["mobile-header-project"]
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
