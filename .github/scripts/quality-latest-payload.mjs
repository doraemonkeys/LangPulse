export function parseBody(bodyText) {
  if (!bodyText.trim()) {
    return null;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText.trim();
  }
}

export function extractObservedDate(payload) {
  if (payload == null) {
    return null;
  }

  if (typeof payload === "string") {
    return isDateString(payload) ? payload : null;
  }

  if (Array.isArray(payload)) {
    for (const value of payload) {
      const extracted = extractObservedDate(value);
      if (extracted) {
        return extracted;
      }
    }

    return null;
  }

  if (typeof payload === "object") {
    const dateKeys = [
      "observed_date",
      "observedDate",
      "latest_observed_date",
      "latestObservedDate",
      "date",
      "latest",
    ];

    for (const key of dateKeys) {
      const value = payload[key];
      if (typeof value === "string" && isDateString(value)) {
        return value;
      }
    }

    for (const value of Object.values(payload)) {
      const extracted = extractObservedDate(value);
      if (extracted) {
        return extracted;
      }
    }
  }

  return null;
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
