import Foundation

enum RecommendationTier: Int, CaseIterable, Identifiable, Comparable {
    case quickWin, highImpact, maintenance
    var id: Int { rawValue }
    static func < (lhs: RecommendationTier, rhs: RecommendationTier) -> Bool { lhs.rawValue < rhs.rawValue }

    var title: String {
        switch self {
        case .quickWin: return "Quick wins"
        case .highImpact: return "High-impact cleanup"
        case .maintenance: return "Maintenance"
        }
    }

    var subtitle: String {
        switch self {
        case .quickWin: return "Low risk, easy to review"
        case .highImpact: return "Bigger savings, review carefully"
        case .maintenance: return "Habits that keep space free"
        }
    }
}

/// Where a recommendation's action leads in the app.
enum RecommendationDestination: Hashable {
    case media(CandidateKind)
    case files(CandidateKind)
    case guide(String)
    case routine
}

struct Recommendation: Identifiable, Hashable {
    let id: String
    let tier: RecommendationTier
    let title: String
    let symbol: String
    let why: String
    /// Nil when iOS gives the app no way to know the size.
    let estimate: ByteEstimate?
    let estimateMethod: String
    let reversibility: Reversibility
    let cloudNote: String?
    let howTo: String
    let itemCount: Int
    let risk: RiskLevel
    let score: Double
    let destination: RecommendationDestination
    var protectedItemsExcluded: Int = 0
    var hasValuableSigns: Bool = false
}

enum RecommendationEngine {
    /// Reclaimable bytes for one candidate after removing protected members.
    /// Returns nil if nothing in the candidate can be cleaned.
    static func reclaimable(_ candidate: CleanupCandidate, protectedIDs: Set<String>) -> (bytes: Int64, items: Int, excluded: Int)? {
        let unprotected = candidate.members.filter { !protectedIDs.contains($0.id) }
        let excluded = candidate.members.count - unprotected.count
        if candidate.kind.isGroupOfCopies {
            guard candidate.members.count > 1, !unprotected.isEmpty else { return nil }
            if excluded > 0 {
                // A protected member is the copy that stays; every unprotected one could go.
                return (unprotected.reduce(0) { $0 + $1.bytes }, unprotected.count, excluded)
            }
            let savings = DuplicateFinder.conservativeSavings(memberSizes: unprotected.map(\.bytes))
            return (savings, unprotected.count - 1, 0)
        }
        guard !unprotected.isEmpty else { return nil }
        return (unprotected.reduce(0) { $0 + $1.bytes }, unprotected.count, excluded)
    }

    static func tier(for kind: CandidateKind) -> RecommendationTier {
        kind.risk == .low ? .quickWin : .highImpact
    }

    /// Ranks by potential space, then discounts for uncertainty, risk, effort and permanence.
    static func score(bytes: Int64, confidence: SizeConfidence, risk: RiskLevel, effort: Effort, reversibility: Reversibility) -> Double {
        let megabytes = Double(max(0, bytes)) / 1_000_000
        let size = log2(1 + megabytes)
        let confidenceWeight: Double
        switch confidence {
        case .measured: confidenceWeight = 1.0
        case .reported: confidenceWeight = 0.95
        case .estimated: confidenceWeight = 0.75
        }
        let riskWeight: Double
        switch risk {
        case .low: riskWeight = 1.0
        case .medium: riskWeight = 0.7
        case .high: riskWeight = 0.4
        }
        let effortWeight: Double
        switch effort {
        case .quick: effortWeight = 1.0
        case .moderate: effortWeight = 0.85
        case .involved: effortWeight = 0.7
        }
        let reversibleWeight: Double = reversibility == .recentlyDeleted ? 1.0 : 0.9
        return size * confidenceWeight * riskWeight * effortWeight * reversibleWeight
    }

    /// Turns raw candidates into ranked, explained recommendations. Protected items never contribute.
    static func recommendations(candidates: [CleanupCandidate], protectedIDs: Set<String>, includeGuides: Bool = true) -> [Recommendation] {
        var result: [Recommendation] = []
        let byKind = Dictionary(grouping: candidates, by: \.kind)
        for kind in CandidateKind.allCases {
            guard let list = byKind[kind] else { continue }
            var bytes: Int64 = 0
            var items = 0
            var excluded = 0
            var confidence = SizeConfidence.measured
            var valuable = false
            for candidate in list {
                excluded += candidate.members.filter { protectedIDs.contains($0.id) }.count
                guard let r = reclaimable(candidate, protectedIDs: protectedIDs) else { continue }
                bytes += r.bytes
                items += r.items
                confidence = min(confidence, candidate.confidence)
                valuable = valuable || candidate.hasValuableSigns
            }
            guard items > 0, bytes > 0 else { continue }
            let estimate = ByteEstimate(bytes: bytes, confidence: confidence)
            var rec = Recommendation(
                id: kind.rawValue,
                tier: tier(for: kind),
                title: kind.title,
                symbol: kind.symbol,
                why: kind.why,
                estimate: estimate,
                estimateMethod: kind.estimateMethod,
                reversibility: kind.reversibility,
                cloudNote: kind.cloudNote,
                howTo: kind.howTo,
                itemCount: items,
                risk: valuable ? max(kind.risk, .medium) : kind.risk,
                score: score(bytes: bytes, confidence: confidence, risk: kind.risk, effort: kind.effort, reversibility: kind.reversibility),
                destination: kind.isPhotoLibrary ? .media(kind) : .files(kind)
            )
            rec.protectedItemsExcluded = excluded
            rec.hasValuableSigns = valuable
            result.append(rec)
        }
        if includeGuides { result.append(contentsOf: guideRecommendations()) }
        return sorted(result)
    }

    /// Recommendations sorted by tier, then score. Items with unknown size go last in their tier.
    static func sorted(_ list: [Recommendation]) -> [Recommendation] {
        list.sorted {
            if $0.tier != $1.tier { return $0.tier < $1.tier }
            if ($0.estimate == nil) != ($1.estimate == nil) { return $0.estimate != nil }
            if $0.score != $1.score { return $0.score > $1.score }
            return $0.title < $1.title
        }
    }

    static func totalEstimate(_ list: [Recommendation]) -> ByteEstimate {
        list.compactMap(\.estimate).total()
    }

    /// Guided manual steps. Their size is unknown to SpaceMate, so they carry no estimate.
    static func guideRecommendations() -> [Recommendation] {
        let highImpact = ["iphone-storage", "offload-apps", "messages"]
        return SettingsGuide.all.map { guide in
            Recommendation(
                id: "guide-\(guide.id)",
                tier: highImpact.contains(guide.id) ? .highImpact : .maintenance,
                title: guide.title,
                symbol: guide.symbol,
                why: guide.summary,
                estimate: nil,
                estimateMethod: "iOS doesn't let apps see this. iPhone Storage in Settings shows the real figures.",
                reversibility: guide.reversibility,
                cloudNote: nil,
                howTo: guide.steps.joined(separator: " → "),
                itemCount: 0,
                risk: guide.risk,
                score: 0,
                destination: .guide(guide.id)
            )
        } + [
            Recommendation(
                id: "routine-review",
                tier: .maintenance,
                title: "Schedule a regular review",
                symbol: "calendar.badge.clock",
                why: "A short weekly or monthly review keeps storage from filling up again.",
                estimate: nil,
                estimateMethod: "Not applicable.",
                reversibility: .notApplicable,
                cloudNote: nil,
                howTo: "Open Routine, set a free-space target and turn on a reminder.",
                itemCount: 0,
                risk: .low,
                score: 0,
                destination: .routine
            ),
        ]
    }
}
