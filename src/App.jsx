import React, { useState, useMemo, useEffect } from "react";
import rawCallsData from "./candidate-calls.json";

const STORAGE_KEY = "qa_review_verdicts_v1";

const QA_WORKFLOW_STAGES = [
  {
    stage: "1. Gatekeeper & Context",
    items: [
      "Wrong Call Direction / Outcome",
      "DPA Status Error (Partial or Missing)",
      "3rd-Party Authority / Voicemail Error",
    ],
  },
  {
    stage: "2. Ground-Truth Alignment",
    items: [
      "Hallucinated / Contradicted Fact",
      "Proposal vs Agreement Confusion",
      "Wrong Date / Time Window Drift",
      "Missing Next Step / Action Item",
    ],
  },
  {
    stage: "3. Selective Redaction & Protocol",
    items: [
      "Leaked Forbidden Amount (Arrears / Payment)",
      "Leaked PII / Private Entity Name",
      "Missing Mandatory Phrase (Consent / Signpost / I&E)",
      "Used Banned Omission / 'Further Action' Term",
    ],
  },
];

const STOP_WORDS = new Set([
  "the", "and", "was", "were", "that", "this", "with", "from", "for", "are",
  "but", "not", "you", "your", "have", "has", "had", "will", "would", "could",
  "should", "been", "into", "about", "after", "before", "while", "when", "where",
  "customer", "agent", "company", "call", "called", "discussed", "agreed", "stated",
]);

// Regex covering £/$ currency, digits, times, dates, and spoken number/date phrases
const HIGHLIGHT_REGEX =
  /([£$]\d+(?:,\d{3})*(?:\.\d{1,2})?|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm|AM|PM)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-first|twenty-second|twenty-third|twenty-fourth|twenty-fifth|twenty-sixth|twenty-seventh|twenty-eighth|twenty-ninth|thirtieth|thirty-first)\s+of\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|tomorrow|today|yesterday)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|fourteen|thirty|fifty|hundred|thousand)[-\s](?:day|days|week|weeks|month|months|pound|pounds)\b|\b\d+(?:\.\d+)?\b)/gi;

function HighlightedText({ text }) {
  if (!text) return null;
  const parts = text.split(HIGHLIGHT_REGEX);
  return (
    <>
      {parts.map((part, idx) =>
        idx % 2 === 1 ? (
          <span
            key={idx}
            className="bg-yellow-200 text-yellow-950 px-1 py-0.5 rounded font-semibold border border-yellow-300"
          >
            {part}
          </span>
        ) : (
          <React.Fragment key={idx}>{part}</React.Fragment>
        )
      )}
    </>
  );
}

// Parse raw transcript string into structured speaker turns
function parseTranscript(transcriptRaw) {
  if (Array.isArray(transcriptRaw)) return transcriptRaw;
  if (!transcriptRaw || typeof transcriptRaw !== "string") return [];

  return transcriptRaw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const match = line.match(
        /^(T\d+)\s*\[(\d{2}:\d{2})\]\s*([^:]+):\s*(.*)$/i
      );
      if (match) {
        return {
          turnId: match[1],
          timestamp: match[2],
          speaker: match[3].trim(),
          text: match[4].trim(),
        };
      }
      return {
        turnId: `T${String(index + 1).padStart(2, "0")}`,
        timestamp: "00:00",
        speaker: "System",
        text: line,
      };
    });
}

// Split summary prose into clickable sentence cards & classify against the 9 protocol steps
function parseSummaryCards(summaryRaw) {
  if (!summaryRaw || typeof summaryRaw !== "string") return [];
  const sentences = summaryRaw
    .split(/(?<=[.!?])\s+|\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  return sentences.map((text, idx) => {
    const lower = text.toLowerCase();
    let category = "General Summary Claim";
    let isActionItem = false;

    if (lower.includes("dpa")) {
      category = "1. Data Protection (DPA)";
    } else if (
      lower.includes("called the") ||
      lower.includes("internal ") ||
      lower.includes("voicemail") ||
      lower.includes("authority to act")
    ) {
      category = "2. Contact Outcome";
    } else if (lower.includes("arrears") || lower.includes("balance")) {
      category = "3. Account Status";
    } else if (
      lower.includes("income") ||
      lower.includes("sick") ||
      lower.includes("job") ||
      lower.includes("contract") ||
      lower.includes("hardship") ||
      lower.includes("repair")
    ) {
      category = "4. Situation & Ability to Pay";
    } else if (
      lower.includes("consent") ||
      lower.includes("vulnerability") ||
      lower.includes("disclosed")
    ) {
      category = "5. Vulnerability & Consent";
    } else if (
      lower.includes("stepchange") ||
      lower.includes("signposted") ||
      lower.includes("citizens advice") ||
      lower.includes("i&e") ||
      lower.includes("credit file") ||
      lower.includes("risk of further action")
    ) {
      category = "6. Affordability, Advice & Compliance";
    } else if (lower.includes("promised") || lower.includes("agreed to pay")) {
      category = "7. Promises to Pay";
      isActionItem = true;
    } else if (
      lower.includes("hold") ||
      lower.includes("payment made") ||
      lower.includes("attempted")
    ) {
      category = "8. Actions Taken";
      isActionItem = true;
    } else if (
      lower.includes("next steps") ||
      lower.includes("prepare") ||
      lower.includes("call on")
    ) {
      category = "9. Next Steps";
      isActionItem = true;
    }

    return {
      id: `CLAIM-${idx + 1}`,
      category,
      text,
      isActionItem,
    };
  });
}


function resolveRelativeDates(callDateStr) {
  if (!callDateStr) return null;
  const base = new Date(`${callDateStr}T12:00:00Z`);
  if (isNaN(base.getTime())) return null;

  const fmt = (d) =>
    d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });

  const dayNames = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ];
  const baseDayName = dayNames[base.getUTCDay()];

  const tomorrow = new Date(base);
  tomorrow.setUTCDate(base.getUTCDate() + 1);

  const upcomingWeekdays = {};
  for (let offset = 1; offset <= 7; offset++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + offset);
    upcomingWeekdays[dayNames[d.getUTCDay()]] = fmt(d);
  }

  return {
    callDay: `${baseDayName}, ${fmt(base)}`,
    tomorrow: fmt(tomorrow),
    upcomingWeekdays,
  };
}


// Extract metadata & run deterministic checks from summary-rules.txt
function analyzeCallAndRules(call, turns) {
  const warnings = [];
  const summary = call.summary || "";
  const summaryLower = summary.toLowerCase();
  const fullTranscript = turns.map((t) => t.text).join(" ");

  // Infer call direction from T01
  const firstTurn = turns[0];
  let inferredDirection = "Unknown";
  if (firstTurn) {
    const t1Lower = firstTurn.text.toLowerCase();
    if (
      firstTurn.speaker.toLowerCase().includes("agent") &&
      (t1Lower.includes("could i speak to") ||
        t1Lower.includes("can i speak to") ||
        t1Lower.includes("calling from"))
    ) {
      inferredDirection = "Outbound (Company called Customer)";
    } else if (
      firstTurn.speaker.toLowerCase().includes("customer") ||
      t1Lower.includes("how can i help")
    ) {
      inferredDirection = "Inbound (Customer called Company)";
    }
  }

  // Check 1: Direction mismatch
  if (
    inferredDirection.startsWith("Outbound") &&
    summaryLower.includes("customer called the company")
  ) {
    warnings.push({
      rule: "Step 2: Call Direction",
      message:
        'Transcript T01 shows an Outbound call from the agent, but summary claims "The customer called the company".',
      evidence: "T01",
    });
  } else if (
    inferredDirection.startsWith("Inbound") &&
    summaryLower.includes("company called the customer")
  ) {
    warnings.push({
      rule: "Step 2: Call Direction",
      message:
        'Transcript openings indicate an Inbound call, but summary claims "The company called the customer".',
      evidence: "T01",
    });
  }

  // Check 2: Vulnerability Consent phrase check
  const consentTurn = turns.find(
    (t) =>
      t.speaker.toLowerCase().includes("agent") &&
      /(happy|permission|consent|okay|mind)\s+for\s+me\s+to\s+(note|record)/i.test(
        t.text
      )
  );
  if (
    consentTurn &&
    !summaryLower.includes("consent gained to record vulnerability")
  ) {
    warnings.push({
      rule: "Step 5: Vulnerability Consent Phrase",
      message:
        'Agent asked permission to record a vulnerability, but summary omits required exact phrase "Consent gained to record vulnerability".',
      evidence: consentTurn.turnId,
    });
  }

  // Check 3: DPA Rule Exception
  const isAgentCustomer = turns.some((t) =>
    t.speaker.toLowerCase().includes("customer")
  );
  if (
    isAgentCustomer &&
    !summaryLower.includes("dpa completed") &&
    !summaryLower.includes("no dpa stated with agent") &&
    !summaryLower.includes("incomplete call") &&
    !summaryLower.includes("voicemail")
  ) {
    warnings.push({
      rule: "Step 1: Mandatory DPA Status",
      message:
        'Agent-customer calls must explicitly state either "DPA completed" or "no DPA stated with agent".',
      evidence: "T01",
    });
  }

  // Check 4: Signposting phrase check
  const signpostTurn = turns.find(
    (t) =>
      t.speaker.toLowerCase().includes("agent") &&
      (t.text.toLowerCase().includes("website") ||
        t.text.toLowerCase().includes("signpost"))
  );
  if (signpostTurn && !summaryLower.includes("customer signposted")) {
    warnings.push({
      rule: "Step 6: Signposting Terminology",
      message:
        'Agent mentioned company website/support page, requiring exact phrase "customer signposted".',
      evidence: signpostTurn.turnId,
    });
  }

  // Check 5: Anonymity leak check (detects if verified customer name appears in summary)
  const dpaTurn = turns.find((t) =>
    /confirm your full name|date of birth/i.test(t.text)
  );
  let detectedCustomer = "Customer";
  if (dpaTurn) {
    const dpaIdx = turns.indexOf(dpaTurn);
    const nextCustomerTurn = turns[dpaIdx + 1];
    if (nextCustomerTurn) {
      const nameCandidate = nextCustomerTurn.text.split(",")[0].trim();
      if (nameCandidate.split(" ").length <= 3) {
        detectedCustomer = nameCandidate;
        const firstParts = nameCandidate
          .split(" ")
          .filter((p) => p.length > 2);
        if (
          firstParts.some((part) =>
            new RegExp(`\\b${part}\\b`, "i").test(summary)
          )
        ) {
          warnings.push({
            rule: "Rule 2: Anonymity Breach",
            message: `Customer name (${nameCandidate}) appears in the summary.`,
            evidence: nextCustomerTurn.turnId,
          });
        }
      }
    }
  }

  // Check 6: American English spelling check
  if (
    /\b(authorized|unauthorized|center|program|canceled|counseling)\b/i.test(
      summary
    )
  ) {
    warnings.push({
      rule: "Rule 7: British English",
      message: "Summary contains American English spelling.",
      evidence: "Summary",
    });
  }

  // Check 7: Possible ASR Hold Hallucination in transcript
  const hallucinationTurn = turns.find((t) =>
    /this is advantage finance\. i'm your agent|i'm calling to discuss your outstanding balance/i.test(
      t.text
    )
  );

  const resolvedDates = resolveRelativeDates(call.call_date);

  // Check 8: Partial DPA Trap (Name + DOB + Address/Postcode all required unless pre-call security stated)
  const earlyTranscript = turns.slice(0, 10).map((t) => t.text).join(" ");
  const hasPreCallSec = /pre-call security|already passed security|security before transfer/i.test(earlyTranscript);
  const hasDOB = /\b(19\d{2}|20\d{2}|eighty|ninety|seventy|sixty|date of birth)\b/i.test(earlyTranscript);
  const hasPostcodeOrAddress = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|street|road|close|lane|avenue|drive|way|court|crescent)\b/i.test(earlyTranscript);

  if (
    summaryLower.includes("dpa completed") &&
    !hasPreCallSec &&
    (!hasDOB || !hasPostcodeOrAddress)
  ) {
    warnings.push({
      rule: "Step 1: Partial DPA Trap",
      message:
        'Summary claims "DPA completed", but transcript appears to be missing either DOB or Address/Postcode verification.',
      evidence: "T03",
    });
  }

  // Check 9: Forbidden Arrears/Balance or Immediate Payment Amounts
  const summarySentences = summary.split(/(?<=[.!?])\s+/);
  summarySentences.forEach((sentence) => {
    const sLow = sentence.toLowerCase();
    const hasCurrency = /£\d+|\b\d+\s*pounds\b/i.test(sentence);
    if (!hasCurrency) return;

    if (/\b(arrears|balance|overdue|owed)\b/i.test(sLow) && !/\b(income|pay|rent|repair|cost|drop|reduced)\b/i.test(sLow)) {
      warnings.push({
        rule: "Financial Rule: Forbidden Arrears/Balance Amount",
        message: `Summary includes a specific amount alongside arrears/balance ("${sentence.trim()}"). Must only state arrears/balance were discussed.`,
        evidence: "Summary",
      });
    }
    if (/\b(payment made|paid today|immediate payment|took a payment|payment of)\b/i.test(sLow)) {
      warnings.push({
        rule: "Financial Rule: Forbidden Immediate Payment Amount",
        message: `Summary includes a specific amount for an immediate payment ("${sentence.trim()}"). Must only state "Payment made."`,
        evidence: "Summary",
      });
    }
  });

  // Check 10: Banned Omission Phrases & Prohibited 'Further Action' in Next Steps
  const bannedOmissionMatch = summary.match(
    /\b(not discussed|n\/a|not applicable|not completed|none discussed|not mentioned)\b/i
  );
  if (bannedOmissionMatch) {
    warnings.push({
      rule: "Rule 1: Critical Omission Breach",
      message: `Summary uses banned negative reporting phrase "${bannedOmissionMatch[0]}". Omit undiscussed categories entirely.`,
      evidence: "Summary",
    });
  }

  if (
    summaryLower.includes("further action") &&
    !summaryLower.includes("risk of further action")
  ) {
    warnings.push({
      rule: "Rule 6 & Step 9: Prohibited 'Further Action' Phrase",
      message:
        'Summary uses "further action" outside the mandatory warning phrase "risk of further action". Use "next steps" for future plans.',
      evidence: "Summary",
    });
  }

  // Check 11: Time Window Precision Drift ("after/before X" -> "at X")
  const timeWindowTurn = turns.find((t) =>
    /\b(after|before|around|between)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\b/i.test(
      t.text
    )
  );
  if (timeWindowTurn && /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(summary)) {
    warnings.push({
      rule: "Rule 4: Time Window Precision Drift",
      message: `Transcript (${timeWindowTurn.turnId}) specifies a relative window ("after/before/around"), but summary converts it to an exact "at [time]" appointment.`,
      evidence: timeWindowTurn.turnId,
    });
  }
  // Check 12: Private Entity Redaction vs Allowed Advice Bodies
  const ALLOWED_ENTITIES =
    /\b(StepChange|Citizens Advice|Money\s*Helper|National Debtline|PayPlan|October|November|December|January|February|March|April|May|June|July|August|September|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|DPA|I&E|UK)\b/gi;
  const scrubbedSummary = summary.replace(ALLOWED_ENTITIES, "");

  const entityLeakMatch = scrubbedSummary.match(
    /\b(?:works?\s+(?:at|for)|employed\s+by|job\s+at|garage\s+called|repaired\s+at|shopped\s+at|bank\s+with)\s+([A-Z][a-zA-Z0-9&'\s-]{2,20})/
  );
  if (entityLeakMatch) {
    warnings.push({
      severity: "definite",
      rule: "Rule 3: Private Entity Leak",
      message: `Summary appears to name a specific employer, garage, or private entity ("${entityLeakMatch[0].trim()}"). Redact private entities while keeping StepChange/Citizens Advice.`,
      evidence: "Summary",
    });
  }
  return {
    inferredDirection,
    detectedCustomer,
    warnings,
    hallucinationTurnId: hallucinationTurn ? hallucinationTurn.turnId : null,
    fullTranscript,
    resolvedDates,
  };
}

// Extract meaningful keywords (plus basic number word equivalents) for claim -> transcript matching
function extractKeywords(text) {
  if (!text) return [];
  const rawTokens = text
    .toLowerCase()
    .replace(/[^a-z0-9£$&\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const expanded = new Set(rawTokens);
  // Add lightweight semantic bridges for collections concepts
  if (text.toLowerCase().includes("dpa")) {
    ["confirm", "security", "birth", "postcode", "address"].forEach((k) =>
      expanded.add(k)
    );
  }
  if (text.toLowerCase().includes("500") || text.includes("£500")) {
    expanded.add("five");
    expanded.add("hundred");
  }
  if (text.toLowerCase().includes("23")) {
    expanded.add("twenty-third");
  }
  if (text.toLowerCase().includes("2 pm") || text.toLowerCase().includes("2pm")) {
    expanded.add("two");
  }
  if (text.toLowerCase().includes("i&e")) {
    expanded.add("income");
    expanded.add("expenditure");
  }
  return Array.from(expanded);
}

export default function App() {
  const calls = useMemo(() => {
    if (Array.isArray(rawCallsData) && rawCallsData.length > 0) {
      return rawCallsData;
    }
    return [];
  }, []);

  const [selectedCallId, setSelectedCallId] = useState(
    () => calls[0]?.id || null
  );
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeClaimId, setActiveClaimId] = useState(null);

  // Persisted QA reviews keyed by call.id
  const [reviews, setReviews] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reviews));
    } catch (e) {
      console.error("Failed to persist reviews to localStorage:", e);
    }
  }, [reviews]);

  const selectedCall = useMemo(
    () => calls.find((c) => c.id === selectedCallId) || calls[0] || null,
    [calls, selectedCallId]
  );

  // Reset active claim selection when switching calls
  useEffect(() => {
    setActiveClaimId(null);
  }, [selectedCallId]);

  const currentReview = useMemo(() => {
    if (!selectedCall) {
      return { status: "Pending", reasons: [], notes: "" };
    }
    return (
      reviews[selectedCall.id] || {
        status: "Pending",
        reasons: [],
        notes: "",
      }
    );
  }, [reviews, selectedCall]);

  const updateCurrentReview = (patch) => {
    if (!selectedCall) return;
    setReviews((prev) => ({
      ...prev,
      [selectedCall.id]: {
        status: prev[selectedCall.id]?.status || "Pending",
        reasons: prev[selectedCall.id]?.reasons || [],
        notes: prev[selectedCall.id]?.notes || "",
        updatedAt: new Date().toISOString(),
        ...patch,
      },
    }));
  };

  const toggleReason = (reason) => {
    const existing = currentReview.reasons || [];
    const next = existing.includes(reason)
      ? existing.filter((r) => r !== reason)
      : [...existing, reason];
    updateCurrentReview({ reasons: next });
  };

  const appendTurnCitation = (turnId) => {
    if (!selectedCall) return;
    const tag = `[${selectedCall.id}#${turnId}]`;
    const existingNotes = currentReview.notes || "";
    if (!existingNotes.includes(tag)) {
      updateCurrentReview({
        notes: existingNotes ? `${existingNotes} ${tag} ` : `${tag} `,
      });
    }
  };

  // Precompute turns, claims, and rule diagnostics for the selected call
  const { turns, summaryCards, actionCards, diagnostics } = useMemo(() => {
    if (!selectedCall) {
      return {
        turns: [],
        summaryCards: [],
        actionCards: [],
        diagnostics: {
          inferredDirection: "",
          detectedCustomer: "",
          warnings: [],
        },
      };
    }
    const parsedTurns = parseTranscript(selectedCall.transcript);
    const parsedCards = parseSummaryCards(selectedCall.summary);
    const actions = parsedCards.filter((c) => c.isActionItem);
    const diag = analyzeCallAndRules(selectedCall, parsedTurns);

    return {
      turns: parsedTurns,
      summaryCards: parsedCards,
      actionCards: actions,
      diagnostics: diag,
    };
  }, [selectedCall]);

  const activeClaim = useMemo(
    () => summaryCards.find((c) => c.id === activeClaimId) || null,
    [summaryCards, activeClaimId]
  );

  const activeKeywords = useMemo(
    () => (activeClaim ? extractKeywords(activeClaim.text) : []),
    [activeClaim]
  );

  // Filter calls in left sidebar
  const filteredCalls = useMemo(() => {
    return calls.filter((call) => {
      const st = reviews[call.id]?.status || "Pending";
      if (statusFilter === "ALL") return true;
      return st.toUpperCase() === statusFilter;
    });
  }, [calls, reviews, statusFilter]);

  // Filter & score transcript turns in right pane
  const displayedTurns = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return turns
      .filter((t) => {
        if (!q) return true;
        return (
          t.text.toLowerCase().includes(q) ||
          t.turnId.toLowerCase().includes(q) ||
          t.speaker.toLowerCase().includes(q)
        );
      })
      .map((t) => {
        const lowerText = t.text.toLowerCase();
        const matchedKeywords = activeKeywords.filter((kw) =>
          lowerText.includes(kw)
        );
        return {
          ...t,
          matchedKeywords,
          isMatched: matchedKeywords.length > 0,
        };
      });
  }, [turns, searchQuery, activeKeywords]);

  // Summary counts for header stats
  const stats = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    calls.forEach((c) => {
      const s = reviews[c.id]?.status;
      if (s === "Approved") approved++;
      if (s === "Rejected") rejected++;
    });
    return {
      total: calls.length,
      approved,
      rejected,
      pending: calls.length - approved - rejected,
    };
  }, [calls, reviews]);

  const handleExportJson = () => {
    const payload = calls.map((c) => ({
      id: c.id,
      call_date: c.call_date,
      status: reviews[c.id]?.status || "Pending",
      confidence:
        reviews[c.id]?.status === "Rejected"
          ? reviews[c.id]?.confidence || "Definite Error"
          : "N/A",
      failure_reasons: reviews[c.id]?.reasons || [],
      notes: reviews[c.id]?.notes || "",
      updated_at: reviews[c.id]?.updatedAt || null,
    }));

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `qa-review-results-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const getStatusBadgeClasses = (status) => {
    if (status === "Approved")
      return "bg-emerald-100 text-emerald-800 border-emerald-300";
    if (status === "Rejected")
      return "bg-rose-100 text-rose-800 border-rose-300";
    return "bg-slate-100 text-slate-700 border-slate-300";
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900 font-sans overflow-hidden">
      {/* Top Header */}
      <header className="h-14 bg-slate-900 text-white px-5 flex items-center justify-between shrink-0 border-b border-slate-800">
        <div className="flex items-center gap-4">
          <h1 className="font-bold text-base tracking-tight">
            Collections Summary QA Workbench
          </h1>
          <div className="hidden md:flex items-center gap-2 text-xs text-slate-300 bg-slate-800 px-3 py-1 rounded-full">
            <span>Total: {stats.total}</span>
            <span className="text-slate-600">|</span>
            <span className="text-emerald-400">Approved: {stats.approved}</span>
            <span className="text-slate-600">|</span>
            <span className="text-rose-400">Rejected: {stats.rejected}</span>
            <span className="text-slate-600">|</span>
            <span className="text-amber-300">Pending: {stats.pending}</span>
          </div>
        </div>

        <button
          onClick={handleExportJson}
          className="bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-xs font-semibold px-3.5 py-2 rounded shadow-sm transition cursor-pointer"
        >
          Export QA Results (JSON)
        </button>
      </header>

      {/* Main 3-Pane Workspace */}
      <div className="flex-1 grid grid-cols-12 min-h-0 overflow-hidden">
        {/* 1. Left Sidebar: Call List & Status Filter */}
        <aside className="col-span-3 lg:col-span-2 border-r border-slate-200 bg-white flex flex-col min-h-0">
          <div className="p-3 border-b border-slate-200 bg-slate-50">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
              Filter by QA Status
            </label>
            <div className="grid grid-cols-2 gap-1 text-xs">
              {["ALL", "PENDING", "APPROVED", "REJECTED"].map((f) => (
                <button
                  key={f}
                  onClick={() => setStatusFilter(f)}
                  className={`py-1 px-2 rounded font-medium border text-center transition cursor-pointer ${
                    statusFilter === f
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                  }`}
                >
                  {f.charAt(0) + f.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {filteredCalls.map((call) => {
              const status = reviews[call.id]?.status || "Pending";
              const isSelected = selectedCall?.id === call.id;
              const previewTurns = parseTranscript(call.transcript);
              const meta = analyzeCallAndRules(call, previewTurns);

              return (
                <button
                  key={call.id}
                  onClick={() => setSelectedCallId(call.id)}
                  className={`w-full text-left p-3 transition flex flex-col gap-1 cursor-pointer ${
                    isSelected
                      ? "bg-indigo-50/90 border-l-4 border-l-indigo-600"
                      : "hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-bold text-xs text-slate-900">
                      {call.id}
                    </span>
                    <span
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${getStatusBadgeClasses(
                        status
                      )}`}
                    >
                      {status}
                    </span>
                  </div>

                  <div className="text-[11px] text-slate-600 truncate">
                    {meta.detectedCustomer} •{" "}
                    {meta.inferredDirection.split(" ")[0]}
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-slate-400 mt-0.5">
                    <span>{call.call_date}</span>
                    <span>{call.estimated_duration}</span>
                  </div>

                  {meta.warnings.length > 0 && (
                    <div className="mt-1 text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 font-medium">
                      {meta.warnings.length} rule flag
                      {meta.warnings.length > 1 ? "s" : ""}
                    </div>
                  )}
                </button>
              );
            })}
            {filteredCalls.length === 0 && (
              <div className="p-6 text-center text-xs text-slate-400">
                No calls match status "{statusFilter}".
              </div>
            )}
          </div>
        </aside>

        {/* 2. Center Pane: AI Summary Under Review */}
        <main className="col-span-4 lg:col-span-5 border-r border-slate-200 bg-slate-50/60 flex flex-col min-h-0">
          {selectedCall ? (
            <>
              <div className="p-3.5 border-b border-slate-200 bg-white flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-bold text-sm text-slate-900">
                      AI Summary Under Review — {selectedCall.id}
                    </h2>
                    <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                      Call Date: {selectedCall.call_date}
                    </span>
                  </div>
                  {diagnostics.resolvedDates && (
                  <div className="w-full mt-2 pt-2 border-t border-slate-100 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
                    <span className="font-semibold text-slate-800">
                      Anchor ({diagnostics.resolvedDates.callDay}):
                    </span>
                    <span className="bg-slate-100 px-1.5 py-0.5 rounded">
                      Tomorrow = <strong>{diagnostics.resolvedDates.tomorrow}</strong>
                    </span>
                    {Object.entries(diagnostics.resolvedDates.upcomingWeekdays).map(
                      ([day, dateStr]) => (
                        <span key={day} className="bg-slate-100 px-1.5 py-0.5 rounded">
                          {day.slice(0, 3)} = <strong>{dateStr}</strong>
                        </span>
                      )
                    )}
                  </div>
                )}
                  <p className="text-xs text-slate-500 mt-0.5">
                    Click any sentence or action card below to highlight related
                    transcript evidence.
                  </p>
                </div>

                {activeClaimId && (
                  <button
                    onClick={() => setActiveClaimId(null)}
                    className="text-xs text-indigo-600 hover:text-indigo-800 font-medium underline cursor-pointer"
                  >
                    Clear selection
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* Automated Protocol Linter Alerts */}
                {diagnostics.warnings.length > 0 && (
                  <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 space-y-1.5">
                    <div className="text-xs font-bold text-amber-900 uppercase tracking-wider">
                      Automated Protocol Checks (summary-rules.txt)
                    </div>
                    {diagnostics.warnings.map((w, idx) => (
                      <div
                        key={idx}
                        className="text-xs text-amber-950 flex items-start justify-between gap-2 bg-white/70 p-2 rounded border border-amber-200"
                      >
                        <div>
                          <span className="font-semibold">{w.rule}: </span>
                          <span>{w.message}</span>
                        </div>
                        {w.evidence !== "Summary" && (
                          <button
                            onClick={() => appendTurnCitation(w.evidence)}
                            className="shrink-0 text-[11px] bg-amber-100 hover:bg-amber-200 text-amber-900 font-mono px-1.5 py-0.5 rounded border border-amber-300 cursor-pointer"
                            title="Add turn ID citation to review notes"
                          >
                            +Cite {w.evidence}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Summary Claim Cards */}
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                    Summary Claims ({summaryCards.length})
                  </h3>
                  <div className="space-y-2">
                    {summaryCards.map((card) => {
                      const isActive = activeClaimId === card.id;
                      return (
                        <div
                          key={card.id}
                          onClick={() =>
                            setActiveClaimId(isActive ? null : card.id)
                          }
                          className={`p-3 rounded-lg border transition cursor-pointer ${
                            isActive
                              ? "bg-indigo-50 border-indigo-500 ring-2 ring-indigo-200 shadow-sm"
                              : "bg-white border-slate-200 hover:border-indigo-300 shadow-2xs"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[11px] font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                              {card.category}
                            </span>
                            <span className="text-[11px] text-slate-400 font-mono">
                              {card.id}
                            </span>
                          </div>
                          <p className="text-sm leading-relaxed text-slate-800">
                            <HighlightedText text={card.text} />
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </section>

                {/* Extracted Action Items & Next Steps */}
                {actionCards.length > 0 && (
                  <section>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                      Extracted Action Items & Next Steps ({actionCards.length})
                    </h3>
                    <div className="space-y-2">
                      {actionCards.map((action) => {
                        const isActive = activeClaimId === action.id;
                        return (
                          <div
                            key={`action-${action.id}`}
                            onClick={() =>
                              setActiveClaimId(isActive ? null : action.id)
                            }
                            className={`p-2.5 rounded-lg border-l-4 border transition cursor-pointer ${
                              isActive
                                ? "bg-emerald-50 border-emerald-500 border-l-emerald-600"
                                : "bg-white border-slate-200 border-l-emerald-500 hover:bg-slate-50"
                            }`}
                          >
                            <div className="text-xs font-semibold text-emerald-800 mb-0.5">
                              {action.category}
                            </div>
                            <div className="text-xs text-slate-700">
                              <HighlightedText text={action.text} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* Full Raw Summary Reference */}
                <section className="pt-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                    Full Raw Summary Paragraph
                  </h3>
                  <div className="p-3 bg-white rounded border border-slate-200 text-xs text-slate-600 leading-relaxed">
                    <HighlightedText text={selectedCall.summary} />
                  </div>
                </section>
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-sm text-slate-400">
              Select a call from the left sidebar to begin reviewing.
            </div>
          )}
        </main>

        {/* 3. Right Pane: Ground Truth Transcript */}
        <section className="col-span-5 lg:col-span-5 bg-white flex flex-col min-h-0">
          <div className="p-3 border-b border-slate-200 bg-white flex items-center justify-between gap-3">
            <div className="flex-1">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search transcript turns, speaker, or Turn ID (e.g. T08)..."
                className="w-full text-xs px-3 py-2 rounded border border-slate-300 focus:outline-none focus:border-indigo-500"
              />
            </div>
            {activeClaim && (
              <div className="text-[11px] bg-indigo-50 text-indigo-800 border border-indigo-200 px-2.5 py-1 rounded shrink-0">
                Matching{" "}
                <strong>
                  {displayedTurns.filter((t) => t.isMatched).length}
                </strong>{" "}
                turns for {activeClaim.id}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
            {displayedTurns.map((turn) => {
              const isAgent = turn.speaker.toLowerCase().includes("agent");
              const isHallucination =
                diagnostics.hallucinationTurnId === turn.turnId;

              return (
                <div
                  key={turn.turnId}
                  className={`p-3 rounded-lg border text-sm transition ${
                    turn.isMatched
                      ? "bg-indigo-50/90 border-indigo-400 ring-1 ring-indigo-300"
                      : isHallucination
                      ? "bg-rose-50/70 border-rose-300"
                      : "bg-white border-slate-200"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">
                        {turn.turnId}
                      </span>
                      <span className="font-mono text-slate-400">
                        [{turn.timestamp}]
                      </span>
                      <span
                        className={`font-semibold ${
                          isAgent ? "text-blue-700" : "text-emerald-700"
                        }`}
                      >
                        {turn.speaker}
                      </span>
                      {isHallucination && (
                        <span className="text-[10px] bg-rose-100 text-rose-800 px-1.5 py-0.5 rounded font-semibold">
                          Suspected ASR Hold Hallucination
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {turn.isMatched && (
                        <span className="text-[10px] bg-indigo-100 text-indigo-800 px-1.5 py-0.5 rounded font-medium">
                          Matched: {turn.matchedKeywords.slice(0, 4).join(", ")}
                        </span>
                      )}
                      <button
                        onClick={() => appendTurnCitation(turn.turnId)}
                        className="text-[11px] text-slate-500 hover:text-indigo-700 font-mono border border-slate-200 hover:border-indigo-300 px-1.5 py-0.5 rounded cursor-pointer"
                        title="Cite this turn in QA notes"
                      >
                        +Cite
                      </button>
                    </div>
                  </div>

                  <p className="text-slate-800 leading-relaxed">
                    <HighlightedText text={turn.text} />
                  </p>
                </div>
              );
            })}

            {displayedTurns.length === 0 && (
              <div className="p-8 text-center text-xs text-slate-400">
                No transcript turns match "{searchQuery}".
              </div>
            )}
          </div>
        </section>
      </div>

      {/* 4. Bottom / Sticky QA Verdict Bar */}
      {selectedCall && (
        <footer className="bg-white border-t-2 border-slate-300 px-5 py-3 shrink-0 shadow-lg">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
            {/* Approve / Reject Controls */}
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500 mr-1">
                Verdict ({selectedCall.id}):
              </span>
              <button
                onClick={() =>
                  updateCurrentReview({ status: "Approved", reasons: [] })
                }
                className={`px-4 py-2 rounded font-semibold text-xs transition cursor-pointer border ${
                  currentReview.status === "Approved"
                    ? "bg-emerald-600 text-white border-emerald-700 shadow-xs"
                    : "bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                }`}
              >
                ✓ Approve Summary
              </button>
              <button
                onClick={() => updateCurrentReview({ status: "Rejected" })}
                className={`px-4 py-2 rounded font-semibold text-xs transition cursor-pointer border ${
                  currentReview.status === "Rejected"
                    ? "bg-rose-600 text-white border-rose-700 shadow-xs"
                    : "bg-white text-rose-700 border-rose-300 hover:bg-rose-50"
                }`}
              >
                ✕ Reject Summary
              </button>
            </div>
            
            {currentReview.status === "Rejected" && (
              <div className="w-full space-y-2.5">
                {/* Failure Reason Checkboxes */}
                <div className="w-full grid grid-cols-1 md:grid-cols-3 gap-2.5 bg-rose-50/70 border border-rose-200 p-2.5 rounded-lg">
                  {QA_WORKFLOW_STAGES.map((group) => (
                    <div
                      key={group.stage}
                      className="bg-white/90 border border-rose-200/80 rounded p-2"
                    >
                      <div className="text-[10px] font-bold uppercase tracking-wider text-rose-900 mb-1.5 border-b border-rose-100 pb-1">
                        {group.stage}
                      </div>
                      <div className="space-y-1">
                        {group.items.map((reason) => {
                          const checked = (currentReview.reasons || []).includes(reason);
                          return (
                            <label
                              key={reason}
                              className="flex items-start gap-1.5 text-[11px] text-slate-800 font-medium cursor-pointer select-none leading-tight"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleReason(reason)}
                                className="mt-0.5 rounded border-rose-300 text-rose-600 focus:ring-rose-500"
                              />
                              <span>{reason}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* QA Confidence / Severity Selector */}
                <div className="bg-amber-50/90 border border-amber-300 rounded-lg p-3 flex items-center justify-between gap-3 shadow-2xs">
                  <div>
                    <div className="text-xs font-bold text-amber-900 uppercase tracking-wider">
                      Evaluation Severity
                    </div>
                    <p className="text-[11px] text-amber-800">
                      Distinguish a definite rule breach from transcript ambiguity or uncertainty.
                    </p>
                  </div>
                  <select
                    value={currentReview.confidence || "Definite Error"}
                    onChange={(e) =>
                      updateCurrentReview({ confidence: e.target.value })
                    }
                    className="text-xs font-semibold px-3 py-1.5 rounded border border-amber-400 bg-white text-amber-950 focus:outline-none focus:ring-2 focus:ring-amber-300 cursor-pointer shadow-2xs"
                  >
                    <option value="Definite Error">🔴 Definite Error</option>
                    <option value="Uncertain / Ambiguous">
                      🟡 Uncertain / Transcript Ambiguous
                    </option>
                  </select>
                </div>
              </div>
            )}

            {/* Free-Text Notes Input */}
            <div className="flex-1 w-full lg:w-auto flex items-center gap-2">
              <input
                type="text"
                value={currentReview.notes || ""}
                onChange={(e) => updateCurrentReview({ notes: e.target.value })}
                placeholder="Reviewer notes & Turn ID evidence (click +Cite on any turn to insert [CALL-ID#Txx])..."
                className="w-full text-xs px-3 py-2 rounded border border-slate-300 focus:outline-none focus:border-indigo-600"
              />
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}