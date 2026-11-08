import CoreGraphics
import Testing
@testable import AI_Wrapper

struct ResponseSwipeTests {
    private let vendors = ["A", "B", "C"]

    @Test func neighborsFollowDisplayOrderAndStopAtTheEnds() {
        #expect(ResponseSwipeRules.neighbor(of: "B", in: vendors, side: .next) == "C")
        #expect(ResponseSwipeRules.neighbor(of: "B", in: vendors, side: .previous) == "A")
        #expect(ResponseSwipeRules.neighbor(of: "C", in: vendors, side: .next) == nil)
        #expect(ResponseSwipeRules.neighbor(of: "A", in: vendors, side: .previous) == nil)
        #expect(ResponseSwipeRules.neighbor(of: nil, in: vendors, side: .next) == nil)
        #expect(ResponseSwipeRules.neighbor(of: "Z", in: vendors, side: .next) == nil)
    }

    @Test func aLoneResponseResistsAndCapsTheDrag() {
        #expect(ResponseSwipeRules.rubberBand(100) == 30)
        #expect(ResponseSwipeRules.rubberBand(-100) == -30)
        #expect(ResponseSwipeRules.rubberBand(1000) == 64)
    }

    @Test func aSwipeCommitsPastTheMidpointOrOnAFlickTheSameWay() {
        #expect(ResponseSwipeRules.commits(dx: -201, velocity: 0, page: 400))
        #expect(!ResponseSwipeRules.commits(dx: -199, velocity: 0, page: 400))
        #expect(ResponseSwipeRules.commits(dx: -50, velocity: -800, page: 400))
        #expect(!ResponseSwipeRules.commits(dx: -50, velocity: 800, page: 400))
    }

    @Test func onlyTheIncomingCardStartsAPageAside() {
        let model = ResponseSwipeModel()
        model.page = 400
        model.neighbor = .init(vendor: "B", side: .next)
        #expect(model.baseOffset(forNeighbor: true) == 400)
        #expect(model.baseOffset(forNeighbor: false) == 0)
        model.neighbor = .init(vendor: "A", side: .previous)
        #expect(model.baseOffset(forNeighbor: true) == -400)
        model.neighbor = nil
        #expect(model.baseOffset(forNeighbor: true) == 0)
    }
}
