@preconcurrency import AVFoundation
import Observation
@preconcurrency import Speech

/// Live microphone transcription that runs entirely on the device; audio never leaves the phone.
@MainActor
@Observable
final class SpeechDictation {
    private(set) var isRecording = false
    private(set) var transcript = ""
    private(set) var errorMessage: String?

    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var sessionID = 0
    @ObservationIgnored private var isStarting = false

    func start() async {
        guard !isRecording, !isStarting else { return }
        isStarting = true
        defer { isStarting = false }
        errorMessage = nil
        transcript = ""
        guard await Self.requestSpeechAuthorization() == .authorized else {
            errorMessage = "Allow Speech Recognition for Enve Family in the Settings app to dictate."
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            errorMessage = "Allow microphone access for Enve Family in the Settings app to dictate."
            return
        }
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            errorMessage = "Dictation isn't available right now."
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            errorMessage = "On-device dictation isn't available for \(Locale.current.localizedString(forIdentifier: recognizer.locale.identifier) ?? "this language") on this iPhone."
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true

        let engine = AVAudioEngine()
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
            Self.installTap(on: engine.inputNode, feeding: request)
            engine.prepare()
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            errorMessage = error.localizedDescription
            return
        }

        self.engine = engine
        self.request = request
        isRecording = true
        sessionID += 1
        let id = sessionID
        // The task holds this closure only until recognition ends, so the strong capture doesn't outlive the session.
        task = Self.recognize(request, with: recognizer) { text, isFinal, failed in
            Task { @MainActor in self.handle(text: text, isFinal: isFinal, failed: failed, sessionID: id) }
        }
    }

    /// Stops listening; the final transcript for what was already heard still arrives afterwards.
    func stop() {
        guard isRecording else { return }
        request?.endAudio()
        finish()
    }

    private func handle(text: String?, isFinal: Bool, failed: Bool, sessionID: Int) {
        guard sessionID == self.sessionID else { return }
        if let text { transcript = text }
        if failed && transcript.isEmpty { errorMessage = "No speech was recognized. Try again." }
        if isFinal || failed { finish() }
    }

    private func finish() {
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        task?.finish()
        engine = nil
        request = nil
        task = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // Nonisolated so the audio and recognition callbacks, which run off the main thread, aren't main-actor isolated.
    private nonisolated static func installTap(on node: AVAudioInputNode, feeding request: SFSpeechAudioBufferRecognitionRequest) {
        node.installTap(onBus: 0, bufferSize: 1024, format: node.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }
    }

    private nonisolated static func recognize(_ request: SFSpeechAudioBufferRecognitionRequest, with recognizer: SFSpeechRecognizer,
                                              update: @escaping @Sendable (String?, Bool, Bool) -> Void) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            update(result?.bestTranscription.formattedString, result?.isFinal ?? false, error != nil)
        }
    }

    private nonisolated static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }
}
