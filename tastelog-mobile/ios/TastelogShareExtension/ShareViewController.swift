import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {

    // MARK: - Config (LOCKED)

    private let appGroupId = "group.com.tastelog.app"
    private let tokenKey = "capture_token" // MUST match what main app writes
    private let capturePath = "/api/drafts/capture"
    private let apiBaseUrlInfoPlistKey = "TASTELOG_API_BASE_URL" // add to Extension Info.plist
    private let maxImages = 5
    private let maxTotalBytes = 20 * 1024 * 1024 // 20 MB cumulative

    // MARK: - UI

    private let spinner = UIActivityIndicatorView(style: .large)
    private let statusLabel = UILabel()
    private let closeButton = UIButton(type: .system)

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        start()
    }

    // MARK: - UI Setup

    private func setupUI() {
        view.backgroundColor = .systemBackground

        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        view.addSubview(spinner)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.text = "Preparing…"
        statusLabel.textAlignment = .center
        statusLabel.font = .systemFont(ofSize: 16, weight: .medium)
        statusLabel.textColor = .label
        statusLabel.numberOfLines = 0
        view.addSubview(statusLabel)

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setTitle("Close", for: .normal)
        closeButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        closeButton.isHidden = true
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        view.addSubview(closeButton)

        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -30),

            statusLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 16),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),

            closeButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 20),
            closeButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])
    }

    // MARK: - Entry

    private func start() {
        do {
            let token = try loadCaptureTokenFailClosed()
            let baseUrl = try loadApiBaseUrlFailClosed()

            updateStatus("Reading shared content…")

            let providers = collectProviders()

            // Always look for a URL provider (Safari shares include one).
            let urlProvider = providers.first {
                $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
            }

            let imageProviders = providers.filter {
                $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
            }

            // --- Extract URL in parallel (non-blocking) ---
            var sharedURL: String? = nil
            let urlGroup = DispatchGroup()

            if let urlProvider {
                urlGroup.enter()
                loadURL(from: urlProvider) { result in
                    if case .success(.sharedURL(let url)) = result {
                        // Only accept http/https URLs — ignore file:// or malformed
                        if url.hasPrefix("http://") || url.hasPrefix("https://") {
                            sharedURL = url
                        }
                    }
                    urlGroup.leave()
                }
            }

            if !imageProviders.isEmpty {
                // --- Images present: start extraction immediately ---
                let capped = Array(imageProviders.prefix(maxImages))
                extractAllImagePayloads(from: capped) { [weak self] imageResult in
                    guard let self else { return }
                    // Single synchronization point — one notify, one upload
                    urlGroup.notify(queue: .main) {
                        switch imageResult {
                        case .failure(let err):
                            // Image extraction failed — fallback to URL if available
                            if let url = sharedURL {
                                self.updateStatus("Importing recipe…")
                                self.upload(payloads: [.sharedURL(url)], token: token, apiBaseUrl: baseUrl)
                            } else {
                                self.showError(err.userMessage)
                            }
                        case .success(let payloads):
                            if payloads.isEmpty {
                                // No valid images — fallback to URL if available
                                if let url = sharedURL {
                                    self.updateStatus("Importing recipe…")
                                    self.upload(payloads: [.sharedURL(url)], token: token, apiBaseUrl: baseUrl)
                                } else {
                                    self.showError("No images could be read.")
                                }
                                return
                            }
                            // Images succeeded — attach URL as metadata only
                            var finalPayloads = payloads
                            if let url = sharedURL {
                                finalPayloads.insert(.sharedURL(url), at: 0)
                            }
                            let imageCount = finalPayloads.filter { if case .file = $0 { return true }; return false }.count
                            self.updateStatus(imageCount > 1 ? "Uploading \(imageCount) images…" : "Uploading…")
                            self.upload(payloads: finalPayloads, token: token, apiBaseUrl: baseUrl)
                        }
                    }
                }
                return
            }

            // --- No images: wait for URL, then decide ---
            urlGroup.notify(queue: .main) { [weak self] in
                guard let self else { return }

                if let url = sharedURL {
                    // URL-only path (e.g. Safari share)
                    self.updateStatus("Importing recipe…")
                    self.upload(payloads: [.sharedURL(url)], token: token, apiBaseUrl: baseUrl)
                    return
                }

                // No images, no URL — fall back to PDF / data / other
                self.extractFirstNonImagePayload(from: providers) { [weak self] result in
                    guard let self else { return }
                    switch result {
                    case .failure(let err):
                        self.showError(err.userMessage)
                    case .success(let payload):
                        self.updateStatus("Uploading…")
                        self.upload(payloads: [payload], token: token, apiBaseUrl: baseUrl)
                    }
                }
            }
        } catch let err as ShareError {
            showError(err.userMessage)
        } catch {
            showError("Unexpected error.")
        }
    }

    /// Collect all NSItemProvider objects from the extension context.
    private func collectProviders() -> [NSItemProvider] {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else { return [] }
        return items.compactMap { $0.attachments }.flatMap { $0 }
    }

    // MARK: - Token / Config

    private func loadCaptureTokenFailClosed() throws -> String {
        let defaults = UserDefaults(suiteName: appGroupId)
        let token = defaults?.string(forKey: tokenKey)
        guard let token, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ShareError.missingToken
        }
        return token
    }

    private func loadApiBaseUrlFailClosed() throws -> String {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: apiBaseUrlInfoPlistKey) as? String else {
            throw ShareError.missingApiBaseUrl
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("http") else {
            throw ShareError.invalidApiBaseUrl
        }
        return trimmed
    }

    // MARK: - Multi-Image Extraction

    /// Load all image providers (up to maxImages), convert each to JPEG.
    /// Returns array of SharePayload.file in the same order as providers.
    private func extractAllImagePayloads(
        from providers: [NSItemProvider],
        completion: @escaping (Result<[SharePayload], ShareError>) -> Void
    ) {
        var results = Array<SharePayload?>(repeating: nil, count: providers.count)
        let group = DispatchGroup()

        for (index, provider) in providers.enumerated() {
            group.enter()
            loadImage(from: provider, index: index) { result in
                if case .success(let payload) = result {
                    results[index] = payload
                }
                group.leave()
            }
        }

        group.notify(queue: .main) {
            let payloads = results.compactMap { $0 }
            if payloads.isEmpty {
                completion(.failure(.failedToLoad))
            } else {
                completion(.success(payloads))
            }
        }
    }

    // MARK: - Single Non-Image Extraction (PDF / URL fallback)

    private func extractFirstNonImagePayload(
        from providers: [NSItemProvider],
        completion: @escaping (Result<SharePayload, ShareError>) -> Void
    ) {
        if let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) }) {
            loadFile(from: p, utType: .pdf, completion: completion)
            return
        }

        if let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.data.identifier) }) {
            loadFile(from: p, utType: .data, completion: completion)
            return
        }

        if let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            loadURL(from: p, completion: completion)
            return
        }

        completion(.failure(.unsupportedContent))
    }

    // MARK: - Individual Loaders

    private func loadImage(from provider: NSItemProvider, index: Int, completion: @escaping (Result<SharePayload, ShareError>) -> Void) {
        provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, error in
            if error != nil {
                completion(.failure(.failedToLoad))
                return
            }

            let filename = "shared_p\(index + 1).jpg"

            // item can be URL or UIImage depending on source
            if let url = item as? URL {
                self.convertToJpegPayload(fileURL: url, filename: filename, completion: completion)
                return
            }

            if let image = item as? UIImage, let data = image.jpegData(compressionQuality: 0.92) {
                self.writeDataToAppGroup(data: data, filename: filename) { result in
                    completion(result.map { SharePayload.file(url: $0, filename: filename, mimeType: "image/jpeg") })
                }
                return
            }

            // Photos on modern iOS may return raw Data (e.g. HEIC bytes).
            if let data = item as? Data,
               let image = UIImage(data: data),
               let jpegData = image.jpegData(compressionQuality: 0.92) {
                self.writeDataToAppGroup(data: jpegData, filename: filename) { result in
                    completion(result.map { SharePayload.file(url: $0, filename: filename, mimeType: "image/jpeg") })
                }
                return
            }

            completion(.failure(.failedToLoad))
        }
    }

    /// Convert any image file URL to JPEG and return as SharePayload.
    private func convertToJpegPayload(
        fileURL: URL,
        filename: String,
        completion: @escaping (Result<SharePayload, ShareError>) -> Void
    ) {
        let needsSecurity = fileURL.startAccessingSecurityScopedResource()
        defer {
            if needsSecurity { fileURL.stopAccessingSecurityScopedResource() }
        }

        do {
            let data = try Data(contentsOf: fileURL)
            guard let image = UIImage(data: data),
                  let jpegData = image.jpegData(compressionQuality: 0.92) else {
                completion(.failure(.failedToLoad))
                return
            }
            writeDataToAppGroup(data: jpegData, filename: filename) { result in
                completion(result.map { SharePayload.file(url: $0, filename: filename, mimeType: "image/jpeg") })
            }
        } catch {
            completion(.failure(.failedToLoad))
        }
    }

    private func loadFile(from provider: NSItemProvider, utType: UTType, completion: @escaping (Result<SharePayload, ShareError>) -> Void) {
        provider.loadItem(forTypeIdentifier: utType.identifier, options: nil) { item, error in
            if error != nil {
                completion(.failure(.failedToLoad))
                return
            }

            if let url = item as? URL {
                self.copyToAppGroupAndReturnPayload(fileURL: url, preferredName: url.lastPathComponent, completion: completion)
                return
            }

            completion(.failure(.failedToLoad))
        }
    }

    private func loadURL(from provider: NSItemProvider, completion: @escaping (Result<SharePayload, ShareError>) -> Void) {
        provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, error in
            if error != nil {
                completion(.failure(.failedToLoad))
                return
            }
            if let url = item as? URL {
                completion(.success(.sharedURL(url.absoluteString)))
                return
            }
            completion(.failure(.failedToLoad))
        }
    }

    // MARK: - App Group File Handling

    private func copyToAppGroupAndReturnPayload(
        fileURL: URL,
        preferredName: String?,
        completion: @escaping (Result<SharePayload, ShareError>) -> Void
    ) {
        let needsSecurity = fileURL.startAccessingSecurityScopedResource()
        defer {
            if needsSecurity { fileURL.stopAccessingSecurityScopedResource() }
        }

        let filename = (preferredName?.isEmpty == false) ? preferredName! : "shared.bin"
        do {
            let data = try Data(contentsOf: fileURL)

            // PDF — pass through without image conversion.
            let ext = (filename as NSString).pathExtension.lowercased()
            if ext == "pdf" {
                writeDataToAppGroup(data: data, filename: filename) { result in
                    completion(result.map { savedURL in
                        SharePayload.file(url: savedURL, filename: filename, mimeType: "application/pdf")
                    })
                }
                return
            }

            // All image formats → JPEG.
            guard let image = UIImage(data: data),
                  let jpegData = image.jpegData(compressionQuality: 0.92) else {
                completion(.failure(.failedToLoad))
                return
            }
            let jpegName = (filename as NSString).deletingPathExtension + ".jpg"
            writeDataToAppGroup(data: jpegData, filename: jpegName) { result in
                completion(result.map { savedURL in
                    SharePayload.file(url: savedURL, filename: jpegName, mimeType: "image/jpeg")
                })
            }
        } catch {
            completion(.failure(.failedToLoad))
        }
    }

    private func writeDataToAppGroup(data: Data, filename: String, completion: @escaping (Result<URL, ShareError>) -> Void) {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            completion(.failure(.appGroupUnavailable))
            return
        }
        let target = container.appendingPathComponent("share").appendingPathComponent(filename)
        do {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: target, options: [.atomic])
            completion(.success(target))
        } catch {
            completion(.failure(.failedToWrite))
        }
    }


    // MARK: - Upload

    private func upload(payloads: [SharePayload], token: String, apiBaseUrl: String) {
        guard let url = URL(string: apiBaseUrl + capturePath) else {
            showError("Invalid API URL.")
            return
        }

        // 15.3.S-CF1a: failure copy depends on what was actually shared.
        // Mixed image+URL shares upload the images (URL is attribution only),
        // so any content-level failure is about the images.
        let inputType = captureInputType(for: payloads)

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120.0

        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // One key per upload attempt: a retry of this attempt must reuse it so the
        // backend returns the same draft instead of creating another. The extension
        // does not retry on its own, so a fresh key per upload() call is correct.
        request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")

        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        do {
            let body = try buildMultipartBody(payloads: payloads, boundary: boundary)

            // Cumulative size check.
            if body.count > maxTotalBytes {
                showError("Total image size exceeds 20 MB. Try fewer or smaller images.")
                return
            }

            request.httpBody = body
        } catch {
            showError("Failed to build upload request.")
            return
        }

        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }

            if let error {
                let nsError = error as NSError
                if nsError.code == NSURLErrorTimedOut {
                    self.showError("The upload timed out. Check your connection and try sharing again.")
                } else if nsError.code == NSURLErrorNotConnectedToInternet || nsError.code == NSURLErrorNetworkConnectionLost {
                    self.showError("No internet connection. Check your network and try sharing again.")
                } else {
                    self.showError("Network error. Check your connection and try again.")
                }
                return
            }

            guard let http = response as? HTTPURLResponse else {
                self.showError("Unexpected response. Try again.")
                return
            }

            guard (200...299).contains(http.statusCode), let data else {
                // 15.3.S-CF1a: decode the stable error code when present;
                // fall back to status-class copy otherwise.
                self.showError(
                    CaptureFailureMapper.message(
                        statusCode: http.statusCode,
                        body: data,
                        inputType: inputType
                    )
                )
                return
            }

            do {
                _ = try JSONDecoder().decode(DraftCaptureResponse.self, from: data)
                self.showSuccessAndDismiss()
            } catch {
                self.showError("Failed to parse server response.")
            }
        }

        task.resume()
    }

    private func captureInputType(for payloads: [SharePayload]) -> CaptureShareInputType {
        var sawURL = false
        var sawPdf = false
        for payload in payloads {
            switch payload {
            case .file(_, _, let mimeType):
                if mimeType == "application/pdf" {
                    sawPdf = true
                } else {
                    return .image
                }
            case .sharedURL:
                sawURL = true
            }
        }
        if sawPdf { return .document }
        return sawURL ? .url : .unknown
    }

    private func buildMultipartBody(payloads: [SharePayload], boundary: String) throws -> Data {
        var body = Data()

        func append(_ string: String) {
            if let data = string.data(using: .utf8) {
                body.append(data)
            }
        }

        // Always set source=share_extension
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"source\"\r\n\r\n")
        append("share_extension\r\n")

        for payload in payloads {
            switch payload {
            case .sharedURL(let urlString):
                append("--\(boundary)\r\n")
                append("Content-Disposition: form-data; name=\"url\"\r\n\r\n")
                append(urlString)
                append("\r\n")

            case .file(let fileUrl, let filename, let mimeType):
                let fileData = try Data(contentsOf: fileUrl)
                if fileData.count > 10 * 1024 * 1024 {
                    throw ShareError.fileTooLarge
                }

                append("--\(boundary)\r\n")
                append("Content-Disposition: form-data; name=\"image\"; filename=\"\(escapeQuotes(filename))\"\r\n")
                append("Content-Type: \(mimeType)\r\n\r\n")
                body.append(fileData)
                append("\r\n")
            }
        }

        append("--\(boundary)--\r\n")
        return body
    }

    private func escapeQuotes(_ s: String) -> String {
        s.replacingOccurrences(of: "\"", with: "\\\"")
    }

    // MARK: - Success

    private func showSuccessAndDismiss() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.spinner.stopAnimating()
            self.statusLabel.textColor = .label
            self.statusLabel.text = "Saved to Drafts.\nOpen Tastelog to review."
            self.closeButton.isHidden = false
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        }
    }

    // MARK: - UI Helpers

    private func updateStatus(_ text: String) {
        DispatchQueue.main.async { [weak self] in
            self?.statusLabel.textColor = .label
            self?.statusLabel.text = text
        }
    }

    private func showError(_ message: String) {
        NSLog("[ShareExt] error: %@", message)
        DispatchQueue.main.async { [weak self] in
            self?.spinner.stopAnimating()
            self?.statusLabel.text = message
            self?.statusLabel.textColor = .systemRed
            self?.closeButton.isHidden = false
        }
    }

    // MARK: - Actions

    @objc private func closeTapped() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}

// MARK: - Models / Types

private enum SharePayload {
    case file(url: URL, filename: String, mimeType: String)
    case sharedURL(String)
}

private struct DraftCaptureResponse: Decodable {
    let id: String
}

private enum ShareError: Error {
    case noContent
    case unsupportedContent
    case failedToLoad
    case failedToWrite
    case appGroupUnavailable
    case missingToken
    case missingApiBaseUrl
    case invalidApiBaseUrl
    case tooManyImages
    case fileTooLarge

    var userMessage: String {
        switch self {
        case .noContent:
            return "No content received."
        case .unsupportedContent:
            return "Unsupported share content."
        case .failedToLoad:
            return "Failed to read shared content."
        case .failedToWrite:
            return "Failed to prepare shared file."
        case .appGroupUnavailable:
            return "App Group is not available."
        case .missingToken:
            return "Your sharing session has expired. Open Tastelog, sign in, and try again."
        case .missingApiBaseUrl:
            return "Missing API configuration."
        case .invalidApiBaseUrl:
            return "Invalid API configuration."
        case .tooManyImages:
            return "Too many images selected. Please select up to 5."
        case .fileTooLarge:
            return "One of the images exceeds 10 MB. Try a smaller image."
        }
    }
}
