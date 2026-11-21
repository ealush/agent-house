import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@Test func parsesAcrossEveryByteBoundary() throws {
    let stream = Data("\u{FEFF}: ping\r\nevent: state\r\ndata: {\"title\":\"שלום 👩🏽‍💻\"}\r\n\r\n".utf8)
    let expected = [ServerSentEvent(name: "state", data: #"{"title":"שלום 👩🏽‍💻"}"#)]
    for split in 0...stream.count {
        var parser = ServerSentEventParser()
        let first = try parser.append(Data(stream.prefix(split)))
        let second = try parser.append(Data(stream.dropFirst(split)))
        #expect(first + second == expected)
    }
    var parser = ServerSentEventParser()
    var events: [ServerSentEvent] = []
    for byte in stream { events += try parser.append(Data([byte])) }
    #expect(events == expected)
}

@Test func parsesMultilineDataAndAllLineEndings() throws {
    var parser = ServerSentEventParser()
    let events = try parser.append(Data("event: patch\rdata: first\rdata:  second\r\rdata:\n\ndata: third\r\n\r\n".utf8))
    #expect(events == [
        ServerSentEvent(name: "patch", data: "first\n second"),
        ServerSentEvent(data: ""),
        ServerSentEvent(data: "third")
    ])
}

@Test func ignoresCommentsAndUnknownFieldsAndResetsEventName() throws {
    var parser = ServerSentEventParser()
    let events = try parser.append(Data("event: discarded\n: ping\n\nunknown: value\ndata: a\n\nevent: patch\ndata: b\n\ndata: c\n\n".utf8))
    #expect(events == [
        ServerSentEvent(data: "a"),
        ServerSentEvent(name: "patch", data: "b"),
        ServerSentEvent(data: "c")
    ])
}

@Test func preservesAndClearsEventIDAndValidatesRetry() throws {
    var parser = ServerSentEventParser()
    let events = try parser.append(Data("id: 42\nretry: 3000\n\ndata: a\n\nid: bad\0id\nretry: +12\ndata: b\n\nid\ndata: c\n\n".utf8))
    #expect(events.map(\.lastEventID) == ["42", "42", ""])
    #expect(parser.lastEventID == "")
    #expect(parser.retryMilliseconds == 3000)
    _ = try parser.append(Data("retry: 999999999999999999999999999\nretry: 1.5\n\n".utf8))
    #expect(parser.retryMilliseconds == 3000)
    _ = try parser.append(Data("retry: 0\n\n".utf8))
    #expect(parser.retryMilliseconds == 0)
}

@Test func eofDoesNotDispatchAnIncompleteEvent() throws {
    var parser = ServerSentEventParser()
    #expect(try parser.append(Data("event: state\ndata: incomplete\n".utf8)).isEmpty)
    parser.finish()
    #expect(throws: ServerSentEventParser.ParseError.closed) {
        try parser.append(Data("\n".utf8))
    }
}

@Test func enforcesLineAndEventBoundsAndClosesAfterFailure() throws {
    var lineParser = ServerSentEventParser(maximumLineBytes: 8)
    #expect(throws: ServerSentEventParser.ParseError.lineTooLarge) {
        try lineParser.append(Data("data: 123".utf8))
    }
    #expect(throws: ServerSentEventParser.ParseError.closed) {
        try lineParser.append(Data("\n\n".utf8))
    }
    var eventParser = ServerSentEventParser(maximumEventBytes: 16)
    #expect(throws: ServerSentEventParser.ParseError.eventTooLarge) {
        try eventParser.append(Data("data: a\ndata: b\ndata: c\n\n".utf8))
    }
    var bounded = ServerSentEventParser(maximumEventBytes: 8)
    #expect(try bounded.append(Data("data: a\n\ndata: b\n\n".utf8)).count == 2)
}

@Test func rejectsMalformedUTF8InsteadOfAlteringStateJSON() {
    var parser = ServerSentEventParser()
    #expect(throws: ServerSentEventParser.ParseError.invalidUTF8) {
        try parser.append(Data([100, 97, 116, 97, 58, 32, 0xFF, 10, 10]))
    }
}
