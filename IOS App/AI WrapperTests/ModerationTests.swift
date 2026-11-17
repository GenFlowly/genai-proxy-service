import Foundation
import Testing
@testable import AI_Wrapper

struct ModerationTests {
    private func owner(username: String? = nil, name: String? = nil) -> SharedItemOwner {
        SharedItemOwner(ownerCustomerId: "CU1", ownerUsername: username, ownerName: name, canBlock: true, canRemove: true, alreadyReported: false)
    }

    @Test func anOwnerIsNamedByUsernameThenNameThenRole() {
        #expect(owner(username: "mara", name: "Mara").label == "@mara")
        #expect(owner(name: "Mara").label == "Mara")
        #expect(owner().label == L("moderation.theOwner"))
    }

    @Test func aBlockedUserIsNamedTheSameWay() {
        #expect(BlockedUser(customerId: "1", username: "sam", name: "Sam O", blockedAt: "").label == "@sam")
        #expect(BlockedUser(customerId: "1", username: nil, name: "Sam O", blockedAt: "").label == "Sam O")
        #expect(BlockedUser(customerId: "1", username: nil, name: nil, blockedAt: "").label == L("moderation.blockedUsers.unknownUser"))
    }

    @Test func initialsComeFromTheNameFirst() {
        #expect(BlockedUser(customerId: "1", username: "sam", name: "Sam Okafor", blockedAt: "").initials == "SO")
        #expect(BlockedUser(customerId: "1", username: "sam", name: nil, blockedAt: "").initials == "S")
    }

    @Test func aReportNeedsAReason() {
        var form = ReportForm()
        #expect(!form.canSend)
        form.reason = .hate
        #expect(form.canSend)
    }

    @Test func detailsAreTrimmedAndBlankOnesLeftOut() {
        #expect(ReportForm(details: "  rude  ").trimmedDetails == "rude")
        #expect(ReportForm(details: "   ").trimmedDetails == nil)
    }

    @Test func detailsAreClippedToTheLimitTheAPIEnforces() {
        #expect(ReportForm.clip(String(repeating: "x", count: 1200)).count == ReportForm.detailsMax)
        #expect(ReportForm.clip("short") == "short")
    }

    @Test(arguments: [("CONTENT_BLOCKED", ModerationRefusal.contentBlocked), ("BLOCKED", ModerationRefusal.blocked)])
    func refusalsAreReadFromTheErrorBody(code: String, expected: ModerationRefusal) {
        let body = Data(#"{"error":"no","code":"\#(code)"}"#.utf8)
        #expect(ModerationRefusal(error: APIError(status: 422, message: "", body: body)) == expected)
    }

    @Test func otherFailuresAreNotRefusals() {
        #expect(ModerationRefusal(error: APIError(status: 500, message: "", body: Data(#"{"error":"x"}"#.utf8))) == nil)
        #expect(ModerationRefusal(error: APIError(status: 500, message: "")) == nil)
        #expect(ModerationRefusal(error: URLError(.notConnectedToInternet)) == nil)
    }

    @Test func refusalsSayWhy() {
        #expect(ModerationRefusal.contentBlocked.shareMessage == L("moderation.shareRefusedByFilter"))
        #expect(ModerationRefusal.blocked.shareMessage == L("moderation.shareRefusedByBlock"))
    }

    @Test func everyReasonHasALabel() {
        for reason in ReportReason.allCases {
            #expect(reason.label != "moderation.report.reasons.\(reason.rawValue)")
        }
    }

    @Test func aSharedItemNamesItsTypeForTheAPI() {
        #expect(SharedItem.conversation("c").entityType == "CONVERSATION")
        #expect(SharedItem.instruction("i").entityType == "INSTRUCTION")
        #expect(SharedItem.instruction("i").entityId == "i")
        #expect(SharedItem.conversation("c").isConversation)
    }

    @Test func theOwnerResponseDecodes() throws {
        let json = Data(#"{"ownerCustomerId":"CU1","ownerUsername":null,"ownerName":"Mara","canBlock":true,"canRemove":false,"alreadyReported":true}"#.utf8)
        let decoded = try JSONDecoder().decode(SharedItemOwner.self, from: json)
        #expect(decoded == SharedItemOwner(ownerCustomerId: "CU1", ownerUsername: nil, ownerName: "Mara", canBlock: true, canRemove: false, alreadyReported: true))
    }

    @Test func aBlockDateIsShownWithOrWithoutFractionalSeconds() {
        #expect(!BlockedUsersSettingsView.displayDate("2026-11-08T10:00:00.123456Z").isEmpty)
        #expect(!BlockedUsersSettingsView.displayDate("2026-11-08T10:00:00Z").isEmpty)
        #expect(BlockedUsersSettingsView.displayDate("not a date").isEmpty)
    }
}
