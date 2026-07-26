import { generateContentTracked } from "../lib/gemini.js";

const MANUAL_SCAN_MODEL = "gemini-2.5-flash"; // Or whichever model was used in frontend

// ==========================================
// P R O M P T S  (Migrated from Frontend)
// ==========================================

const IDENTIFY_SCAN_PROMPT = `
  Identify the food or drink in this image.
  Return ONLY a JSON object with exactly two keys:
  - 'name' (string, the common name of the item)
  - 'type' (string, either 'food' or 'drink')
  Do not include any other information.
`;

const FOOD_SCAN_PROMPT = `
Analyze this image as a world-class nutritionist and bio-hacker.
Identify the food/drink item with EXTREME PRECISION.
If there is a nutrition label or text, perform OCR with 100% ACCURACY. Do not miss any numbers or text.
If no label, estimate based on visual cues.

Return a JSON object with this EXACT schema (ALL FIELDS REQUIRED):
{
  "name": "Common Name",
  "honest_name": "Brutally Honest Name (e.g. 'Liquid Diabetes')",
  "sugar": number (grams, integer, MUST BE ESTIMATED IF UNKNOWN),
  "calories": number (kcal, integer, MUST BE ESTIMATED IF UNKNOWN),
  "trans_fat": number (grams, MUST BE ESTIMATED IF UNKNOWN),
  "salt": number (grams, MUST BE ESTIMATED IF UNKNOWN),
  "macros": {
    "protein": number (grams, MUST BE ESTIMATED),
    "carbs": number (grams, MUST BE ESTIMATED),
    "fat": number (grams, MUST BE ESTIMATED),
    "fiber": number (grams, MUST BE ESTIMATED)
  },
  "vitamins": [
    { "name": "Vitamin Name", "amount": "Amount with unit", "percent": number (Estimated DV% - MUST BE > 0) }
  ],
  "glycemicIndex": number (0-100),
  "type": "food" | "drink",
  "verdict": "Short, punchy verdict (max 15 words).",
  "focus_tax": number (0-100, estimated % drop in cognitive focus),
  "aging_grade": "Low" | "Medium" | "High" | "Severe",
  "sleep_penalty": "None" | "Mild" | "Disruptive",
  "confidence_score": number (0-100),
  "sugar_sources": ["Source 1", "Source 2"],
  "visual_cues": ["Cue 1", "Cue 2"],
  "ingredients": ["Ing 1", "Ing 2"],
  "explanation": "Brief explanation of the analysis.",
  "organ_impact": [
    {
      "id": "brain",
      "stressLevel": 0,
      "message": "Short status (e.g. Dopamine Flood)",
      "detail": "Specific medical explanation of how THIS food affects the brain."
    },
    { "id": "skin", "stressLevel": 0, "message": "Status", "detail": "Specific effect on collagen/hydration." },
    { "id": "heart", "stressLevel": 0, "message": "Status", "detail": "Specific effect on blood pressure/inflammation." },
    { "id": "liver", "stressLevel": 0, "message": "Status", "detail": "Specific effect on fat storage/detox." },
    { "id": "pancreas", "stressLevel": 0, "message": "Status", "detail": "Specific effect on insulin." },
    { "id": "kidneys", "stressLevel": 0, "message": "Status", "detail": "Specific effect on filtration." },
    { "id": "gut", "stressLevel": 0, "message": "Status", "detail": "Specific effect on microbiome." }
  ]
}

CRITICAL:
- If you see a label, TRUST THE LABEL DATA ABOVE ALL ELSE.
- For vitamins, extract as many as visible on the label.
- If no label, YOU MUST ESTIMATE calories, macros, AND VITAMINS based on the food type.
- DO NOT RETURN EMPTY VITAMINS. Estimate at least 4 key vitamins/minerals (e.g. Vit C, Iron, Calcium, Vit A) typical for this food.
- DO NOT RETURN 0 for calories/macros unless it is water.
- Be harsh but accurate. DO NOT use exaggerated numbers like 999999 for calories even if the food is unhealthy; provide the most realistic biological estimate.
- For 'organ_impact', you MUST generate unique, specific medical details for EACH organ based on the specific ingredients of the food. Do NOT use generic text.
`;

const LABEL_SCAN_PROMPT = `
PERFORM A HIGH-PRECISION FORENSIC NUTRITION ANALYSIS.

**OBJECTIVE:** Extract the EXACT sugar content and identify the product with 100% OCR ACCURACY.

**PHASE 1: BRAND RECOGNITION & CROSS-REFERENCE**
1. Identify the Brand and Product Name (e.g., "Indomie Goreng", "Coca Cola", "Oreo").
2. **CRITICAL:** If the product is a known brand (like "Indomie"), use your INTERNAL KNOWLEDGE to validate the OCR result.
   - Example: "Indomie Goreng" typically has ~8-9g of sugar (from the seasoning oil/kecap). If OCR sees "0g", it is likely reading the dry noodle block only. YOU MUST CORRECT THIS using general product knowledge.
   - Example: "Coke" has ~39g. If label is folded, use known data.

**PHASE 2: OCR & DATA EXTRACTION (ZERO ERROR TOLERANCE)**
1. Locate "NUTRITION FACTS" or "**INFORMASI NILAI GIZI**".
2. Find "**Total Sugars**" / "**Gula Total**" / "**Gula**".
   - IGNORE "Carbohydrates" unless sugar is missing.
   - CAREFUL: Check if the column is "Per Serving" (Per Sajian) or "Per 100g". **Prioritize "Per Serving"**.
3. Extract the **Serving Size** (Takaran Saji).
4. Identify **Sodium** / **Natrium** (mg) and **Trans Fat** (g).
5. Do not miss any numbers. If text is blurry, use context clues.

**PHASE 3: DECEPTION DETECTION**
1. Check Ingredients ("Komposisi"). Look for hidden sugars: Dextrose, Maltodextrin, High Fructose Corn Syrup, Cane Juice, Kecap Manis (Soy Sauce often has sugar).
2. Detect Tricks: "0g Sugar" but "15g Added Sugars"? Or small serving sizes (e.g. 5 pieces) to hide load?

RETURN STRICT JSON:
{
  "label_honesty_score": number (1-10),
  "product_name": "string" (Detected Brand Name),
  "hidden_additives": ["string"],
  "deception_technique": "string" (e.g. "Serving Size Manipulation", "Sauce Separation"),
  "technique_explanation": "string",
  "ingredients_snippet": "string",
  "verdict": "string",
  "hidden_sugar_grams": number (The MOST ACCURATE single serving sugar amount. Use internal knowledge if OCR is ambiguous),
  "serving_size": "string" (e.g. "85g", "1 Bottle", "1 Pack"),
  "sodium_impact": "Low" | "Medium" | "High" | "Critical",
  "sodium_explanation": "string",
  "trans_fat": number (grams, MUST BE ESTIMATED IF UNKNOWN),
  "salt": number (grams, MUST BE ESTIMATED IF UNKNOWN)
}
`;

const QR_SCAN_PROMPT = `
ANALYZE THE IMAGE FOR A QR CODE, BARCODE, OR PRODUCT PACKAGING.
Identify the product precisely.

PERFORM A "FULL DISCLOSURE" FORENSIC AUDIT.
Imagine you are a biological detective exposing the hidden industrial ingredients.

RETURN STRICT JSON:
{
  "product_name": "string (e.g. Instant Noodles, Soda Brand)",
  "sugar_grams": number,
  "calories": number,
  "risk_level": "High" | "Moderate" | "Low",
  "additives": [
    {
      "name": "Chemical Name (e.g. Sodium Polyphosphate, Hydrogenated Oil)",
      "role": "Function (e.g. Texture Agent, Trans Fat)",
      "risk": "Short Medical Risk (e.g. KIDNEY STRESS, ARTERIAL CLOG, LIVER FAT)"
    },
    { "name": "Chemical Name", "role": "Function", "risk": "Medical Risk" },
    { "name": "Chemical Name", "role": "Function", "risk": "Medical Risk" }
  ],
  "side_effects": [
    {
      "condition": "Medical Alert (e.g. Water Retention Alert, Digestive Stress)",
      "severity": "High" | "Moderate" | "Low",
      "description": "Specific biological mechanism (e.g. Excessive sodium (820mg) will cause facial puffiness...)",
      "color": "blue"
    },
    {
      "condition": "Secondary Alert",
      "severity": "Moderate",
      "description": "Short explanation.",
      "color": "pink"
    }
  ]
}
`;

const RECEIPT_SCAN_PROMPT = `
  You are a Financial Forensics AI specialized in Nutrition.
  Analyze this receipt image.

  1. **DETECT CURRENCY:** Look for symbols (Rp, $, €, £, ¥, etc) or country names/addresses on the receipt header. Default to "USD" if strictly ambiguous, but prioritize local context (e.g., "Indomaret" = IDR/Rp).
  2. Perform OCR to extract all items and prices.
  3. Identify which items are "Sugary" or "Highly Processed" (Soda, Candy, Cookies, Sauces, Sweet Bakery).
  4. Identify "Real Food" (Meat, Veg, Fruit, Eggs).
  5. Calculate the TOTAL MONEY SPENT on Sugary items vs Total Bill using the DETECTED CURRENCY.

  Return strictly JSON:
  {
    "currency": "string", // e.g. "Rp", "$", "€", "£"
    "totalSpent": number,
    "wastedOnSugar": number,
    "sugarPercentage": number,
    "items": [
      { "name": "string", "price": number, "isSugary": boolean, "sugarGrams": number (estimate) }
    ],
    "financialVerdict": "A brutal, sarcastic 1-sentence summary comparing the wasted money to something better (e.g., 'You wasted Rp 50.000 on poison; could have bought 2kg of chicken.')"
  }
`;

const VERSUS_SCAN_PROMPT = `
  You are a Tactical Nutrition Combat Referee.
  You have been provided with TWO separate image inputs:
  1. ITEM A (First Image)
  2. ITEM B (Second Image)

  Compare them HEAD-TO-HEAD for a person trying to avoid sugar/inflammation.

  Return strictly JSON:
  {
    "winner": "A" or "B",
    "itemA": {
       "name": "string", "description": "Short subtitle e.g. 'With Hazelnut Syrup'", "sugar": number, "calories": number, "score": number (0-100),
       "pros": ["string"], "cons": ["string"]
    },
    "itemB": {
       "name": "string", "description": "Short subtitle e.g. 'Single Patty, No Sides'", "sugar": number, "calories": number, "score": number (0-100),
       "pros": ["string"], "cons": ["string"]
    },
    "verdict": "A clear, decisive statement on why the winner won."
  }
`;

const SKIN_SCAN_PROMPT = `
You are a Dermatology Intelligence Unit.
Analyze the user's face in the image for signs of "Sugar Face" (Glycation) and Systemic Inflammation.

1. **MAP THE FACE & IDENTIFY ISSUES**:
   - Detect 6-8 distinct zones with issues. Look for: Forehead lines, Puffy eyes, Dark circles, Sagging cheeks, Jawline acne, Dullness, Redness.
   - **BE SPECIFIC**: Do NOT give generic results. If the user has clear skin, report "Optimal". If they have acne, report "Inflammation". Match the visual evidence.
   - Use ONLY these zone names (match exactly): "Forehead", "Left Eye", "Right Eye", "Left Cheek", "Right Cheek", "Chin", "Nose", "Upper Lip"

2. **DO NOT estimate coordinates** — coordinates will be computed precisely from face landmark data and injected by the server.

3. **GENERATE A UNIQUE RESCUE PROTOCOL**:
   - The "recommendations" object MUST be tailored to the detected issues.
   - Skincare: Specific ingredients (e.g. "Salicylic Acid" for acne, "Peptides" for wrinkles, "Caffeine" for puffiness).
   - Diet: Specific foods to eat/avoid based on the scan.

Return strictly JSON (NO coordinates field needed in faceZones):
{
  "biologicalAge": number,
  "glycationLevel": "Low" | "Moderate" | "Critical",
  "detectedIssues": ["string", "string"],
  "faceZones": [
     {
       "area": "Forehead" | "Left Eye" | "Right Eye" | "Left Cheek" | "Right Cheek" | "Chin" | "Nose" | "Upper Lip",
       "condition": "string",
       "severity": "Low"|"Medium"|"High",
       "treatment": "string",
       "explanation": "Specific medical observation for this exact zone."
     }
  ],
  "projection": "A scary prediction of what happens in 5 years if sugar intake is not reduced.",
  "recommendations": {
      "skincare": "Specific skincare routine advice.",
      "diet": "Specific dietary changes.",
      "habit": "Specific lifestyle habit.",
      "powerFoods": ["Food 1", "Food 2", "Food 3"],
      "avoidFoods": ["Food 1", "Food 2", "Food 3"],
      "emergencyFix": "Immediate quick fix (e.g. Ice roller, Green tea bag)."
  }
}
`;

const ADDON_SCAN_PROMPT = `
You are a precise nutrition calculator.

Analyze the following food/drink add-on text.
The add-on may be something like:
- "extra cheese"
- "2 tbsp sugar"
- "boba topping"
- "chocolate syrup"
- "nasi putih setengah porsi"
- "sambal manis"
- "creamer"

Return ONLY strict JSON with this exact schema:

{
  "name": "string",
  "sugar": number,
  "calories": number,
  "glycemicIndex": number,
  "type": "food" | "drink",
  "macros": {
    "protein": number,
    "carbs": number,
    "fat": number,
    "fiber": number
  },
  "verdict": "short nutrition verdict"
}

Rules:
- Estimate realistic nutrition values for one typical serving.
- Do not return null.
- Do not return markdown.
- Do not wrap JSON in code fences.
- sugar must be grams.
- calories must be kcal.
- glycemicIndex must be 0-100.
`;

// ==========================================
// L A N D M A R K  H E L P E R S
// ==========================================

/** Indices MediaPipe per zona wajah (canonical 478-point model) */
const ZONE_LANDMARK_INDICES: Record<string, number[]> = {
  Forehead: [10, 338, 297, 332, 284, 251, 389, 109, 67, 103, 54, 21],
  "Left Eye": [159, 145, 133, 173, 157, 158, 144, 153, 154, 155],
  "Right Eye": [386, 374, 362, 398, 384, 385, 373, 380, 381, 382],
  "Left Cheek": [116, 123, 147, 187, 207, 206, 203, 36, 101, 119],
  "Right Cheek": [345, 352, 376, 411, 427, 426, 423, 266, 330, 348],
  Chin: [152, 175, 148, 176, 149, 150, 136, 172, 58, 132],
  Nose: [1, 4, 5, 195, 197, 6, 168, 8],
  "Upper Lip": [0, 267, 269, 270, 409, 291, 375, 321, 405, 314],
};

/**
 * Hitung centroid koordinat (0–100%) dari sekumpulan landmark indices.
 */
function computeZoneCentroid(
  landmarks: { x: number; y: number; z: number }[],
  indices: number[],
): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const idx of indices) {
    const pt = landmarks[idx];
    if (pt) {
      sumX += pt.x;
      sumY += pt.y;
      count++;
    }
  }
  if (count === 0) return { x: 50, y: 50 };
  return {
    x: parseFloat(((sumX / count) * 100).toFixed(1)),
    y: parseFloat(((sumY / count) * 100).toFixed(1)),
  };
}

/**
 * Build lookup map: zoneName → koordinat presisi dari landmark MediaPipe.
 */
function buildZoneCoordinateMap(
  landmarks: { x: number; y: number; z: number }[],
): Record<string, { x: number; y: number }> {
  const map: Record<string, { x: number; y: number }> = {};
  for (const [zone, indices] of Object.entries(ZONE_LANDMARK_INDICES)) {
    map[zone] = computeZoneCentroid(landmarks, indices);
  }
  return map;
}

// ==========================================
// S E R V I C E  M E T H O D S
// ==========================================

/**
 * Execute standard scan utilizing the selected prompt
 */
export const executeStandardScan = async (
  base64Image: string,
  scanMode: "food" | "label" | "qr" | "receipt",
  userId: string,
) => {
  let userPrompt = "";
  if (scanMode === "food") userPrompt = FOOD_SCAN_PROMPT;
  else if (scanMode === "label") userPrompt = LABEL_SCAN_PROMPT;
  else if (scanMode === "qr") userPrompt = QR_SCAN_PROMPT;
  else if (scanMode === "receipt") userPrompt = RECEIPT_SCAN_PROMPT;

  const response = await generateContentTracked(
    {
      model: MANUAL_SCAN_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: base64Image } },
            { text: userPrompt },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
      },
    },
    { feature: `scan.${scanMode}`, userId },
  );

  if (response.text) {
    const rawText = response.text
      .replace(/\`\`\`json/g, "")
      .replace(/\`\`\`/g, "")
      .trim();
    return JSON.parse(rawText);
  }

  throw new Error("Failed to extract text from AI response");
};

/**
 * Execute skin/bio scan (glycation & inflammation analysis on a face image).
 *
 * Jika `landmarks` disediakan (478 points dari MediaPipe FE):
 *   - Koordinat zona dihitung secara presisi dari landmark nyata
 *   - Gemini fokus analisis kondisi kulit, tidak perlu tebak koordinat
 *
 * Jika `landmarks` tidak ada (fallback — upload gambar langsung):
 *   - Koordinat zona diisi dari hardcoded fallback berdasarkan nama zona
 */
export const executeSkinScan = async (
  base64Image: string,
  userId: string,
  landmarks?: { x: number; y: number; z: number }[],
) => {
  const response = await generateContentTracked(
    {
      model: MANUAL_SCAN_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: base64Image } },
            { text: SKIN_SCAN_PROMPT },
          ],
        },
      ],
      config: { responseMimeType: "application/json" },
    },
    { feature: "scan.skin", userId },
  );

  if (!response.text) {
    throw new Error("Failed to extract text from AI response");
  }

  const rawText = response.text
    .replace(/\`\`\`json/g, "")
    .replace(/\`\`\`/g, "")
    .trim();

  const result = JSON.parse(rawText);

  // Inject koordinat presisi ke setiap faceZone
  if (result.faceZones && Array.isArray(result.faceZones)) {
    if (landmarks && landmarks.length >= 400) {
      // Mode presisi: pakai koordinat dari MediaPipe FE
      const coordMap = buildZoneCoordinateMap(landmarks);
      result.faceZones = result.faceZones.map((zone: any) => ({
        ...zone,
        coordinates: coordMap[zone.area] ?? getFallbackCoordinate(zone.area),
      }));
    } else {
      // Mode fallback: koordinat dari nama zona
      result.faceZones = result.faceZones.map((zone: any) => ({
        ...zone,
        coordinates: zone.coordinates ?? getFallbackCoordinate(zone.area),
      }));
    }
  }

  return result;
};

/**
 * Koordinat fallback berdasarkan nama zona (persen 0-100, proporsi wajah standar).
 * Digunakan saat landmark dari MediaPipe tidak tersedia.
 */
function getFallbackCoordinate(area: string): { x: number; y: number } {
  const a = (area ?? "").toLowerCase();
  if (a.includes("forehead")) return { x: 50, y: 22 };
  if (a.includes("left eye")) return { x: 35, y: 38 };
  if (a.includes("right eye")) return { x: 65, y: 38 };
  if (a.includes("left cheek")) return { x: 28, y: 57 };
  if (a.includes("right cheek")) return { x: 72, y: 57 };
  if (a.includes("nose")) return { x: 50, y: 50 };
  if (a.includes("upper lip") || a.includes("mouth")) return { x: 50, y: 65 };
  if (a.includes("chin") || a.includes("jaw")) return { x: 50, y: 77 };
  if (a.includes("neck")) return { x: 50, y: 90 };
  return { x: 50, y: 50 };
}

/**
 * Execute re-analyze scan with manual name/type correction.
 * User provides a manual name (and optionally an image) to re-analyze a food item.
 */
export const executeReanalyzeScan = async (
  manualName: string,
  manualType: "food" | "drink",
  userId: string,
  base64Image?: string,
) => {
  const userHintPrompt =
    manualName === "Unknown Item"
      ? `Please analyze this specific item, taking into account the provided image. Return the analysis in the exact same JSON format as requested.`
      : `The user has manually identified this item as: "${manualName}" (Type: ${manualType}). Please analyze this specific item, taking into account the provided image if provided, but prioritize the user's manual identification for nutritional facts. Return the analysis in the exact same JSON format as requested.`;

  const parts: any[] = [];
  if (base64Image) {
    parts.push({ inlineData: { mimeType: "image/jpeg", data: base64Image } });
  }
  parts.push({ text: userHintPrompt });
  parts.push({ text: FOOD_SCAN_PROMPT });

  const response = await generateContentTracked(
    {
      model: MANUAL_SCAN_MODEL,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json" },
    },
    { feature: "scan.reanalyze", userId },
  );

  if (response.text) {
    const rawText = response.text
      .replace(/\`\`\`json/g, "")
      .replace(/\`\`\`/g, "")
      .trim();
    return JSON.parse(rawText);
  }

  throw new Error("Failed to extract text from AI response");
};

/**
 * Execute Versus scan utilizing the versus prompt and two images
 */
export const executeVersusScan = async (
  base64ImageA: string,
  base64ImageB: string,
  userId: string,
) => {
  const contents = [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: base64ImageA } },
        { text: "Item A (First Image)" },
        { inlineData: { mimeType: "image/jpeg", data: base64ImageB } },
        { text: "Item B (Second Image)" },
        { text: VERSUS_SCAN_PROMPT },
      ],
    },
  ];

  const response = await generateContentTracked(
    {
      model: MANUAL_SCAN_MODEL,
      contents,
      config: { responseMimeType: "application/json" },
    },
    { feature: "scan.versus", userId },
  );

  if (response.text) {
    const rawText = response.text
      .replace(/\`\`\`json/g, "")
      .replace(/\`\`\`/g, "")
      .trim();
    return JSON.parse(rawText);
  }

  throw new Error("Failed to extract text from AI response");
};

export const executeAddonScan = async (addOnText: string, userId: string) => {
  const response = await generateContentTracked(
    {
      model: MANUAL_SCAN_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${ADDON_SCAN_PROMPT}\n\nADD-ON ITEM:\n${addOnText}`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
      },
    },
    { feature: "scan.addon", userId },
  );

  if (response.text) {
    const rawText = response.text
      .replace(/\`\`\`json/g, "")
      .replace(/\`\`\`/g, "")
      .trim();

    return JSON.parse(rawText);
  }

  throw new Error("Failed to extract text from AI response");
};
