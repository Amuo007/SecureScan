# Scoring Rules

All score calculation happens in application code. Claude never calculates scores — it only returns raw counts.

## Raw Counts Structure

Claude returns counts per NIST category per severity level:

```json
{
  "identify": { "CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0 },
  "protect":  { "CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0 },
  "detect":   { "CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0 },
  "respond":  { "CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0 },
  "recover":  { "CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0 }
}
```

## Points Per Severity

| Severity | Points |
|----------|--------|
| CRITICAL | 20     |
| HIGH     | 10     |
| MEDIUM   | 5      |
| LOW      | 2      |

## Category Score (0–100)

Each NIST category gets its own score independently.

```
categoryRawScore = (CRITICAL × 20) + (HIGH × 10) + (MEDIUM × 5) + (LOW × 2)
categoryScore = min(categoryRawScore, 100)
```

Higher score = more dangerous. 0 = no issues found.

## Overall Score (0–100)

All five NIST categories are weighted equally.

```
overallScore = min(
  (identify.raw + protect.raw + detect.raw + respond.raw + recover.raw),
  100
)
```

Where each `.raw` = (CRITICAL × 20) + (HIGH × 10) + (MEDIUM × 5) + (LOW × 2) for that category.

## Risk Level

| Score  | Risk Level |
|--------|------------|
| 0–25   | LOW        |
| 26–50  | MEDIUM     |
| 51–75  | HIGH       |
| 76–100 | CRITICAL   |

## NIST Letter Grades

Letter grades are assigned by Claude in the final report based on raw counts, not score.

| Condition                              | Grade |
|----------------------------------------|-------|
| No HIGH or CRITICAL findings           | A     |
| 1–2 HIGH, no CRITICAL                  | B     |
| 3–5 HIGH or exactly 1 CRITICAL         | C     |
| 2–3 CRITICAL or many HIGH (6+)         | D     |
| 4+ CRITICAL findings                   | F     |

## Question Score Modifier

Each questionnaire answer can adjust the score for its NIST category.

Each question is tied to one NIST category. If the answer reveals a risk:
- Bad answer to a question in a category → add penalty points to that category's raw score before final calculation
- Good answer → no change (the code scan already captured the confirmed issues)

Penalty per bad answer:
- Questions marked as HIGH risk_if_bad → +10 points to that category
- Questions marked as MEDIUM risk_if_bad → +5 points to that category

The application must determine risk level of bad answers. A simple heuristic: if the question's `risk_if_bad` mentions data loss, unauthorized access, or no plan → HIGH. Otherwise → MEDIUM.

## Implementation Reference

```javascript
function calculateScore(rawCounts, questionAnswers, questions) {
  const weights = { CRITICAL: 20, HIGH: 10, MEDIUM: 5, LOW: 2 };
  const categories = ['identify', 'protect', 'detect', 'respond', 'recover'];

  // Base scores from code scan
  const categoryScores = {};
  let totalRaw = 0;

  for (const cat of categories) {
    const counts = rawCounts[cat] || {};
    let raw = 0;
    for (const [sev, pts] of Object.entries(weights)) {
      raw += (counts[sev] || 0) * pts;
    }
    categoryScores[cat] = raw;
    totalRaw += raw;
  }

  // Add question penalties
  questions.forEach((q, i) => {
    const answer = questionAnswers[i];
    const isBadAnswer = answer === 'No' || answer === q.options[q.options.length - 1];
    if (isBadAnswer) {
      const riskText = (q.risk_if_bad || '').toLowerCase();
      const penalty = (riskText.includes('data loss') || riskText.includes('unauthorized') || riskText.includes('no plan')) ? 10 : 5;
      categoryScores[q.nist_category] += penalty;
      totalRaw += penalty;
    }
  });

  // Cap each category at 100
  for (const cat of categories) {
    categoryScores[cat] = Math.min(categoryScores[cat], 100);
  }

  const overallScore = Math.min(totalRaw, 100);

  const riskLevel =
    overallScore <= 25 ? 'LOW' :
    overallScore <= 50 ? 'MEDIUM' :
    overallScore <= 75 ? 'HIGH' : 'CRITICAL';

  return { overallScore, riskLevel, categoryScores };
}
```