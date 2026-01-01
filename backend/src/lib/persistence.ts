/**
 * Simple JSON file persistence for state recovery.
 * Stores data in .flightpath/data/ directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Data directory relative to backend
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../.flightpath/data");

/**
 * Ensure the data directory exists
 */
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Get the path to a data file
 */
function getFilePath(filename: string): string {
  return join(DATA_DIR, filename);
}

/**
 * Save data to a JSON file
 */
export function saveToFile<T>(filename: string, data: T): void {
  try {
    ensureDataDir();
    const filePath = getFilePath(filename);
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error(`Failed to save ${filename}:`, err);
  }
}

/**
 * Load data from a JSON file
 * Returns null if file doesn't exist or is invalid
 */
export function loadFromFile<T>(filename: string): T | null {
  try {
    const filePath = getFilePath(filename);
    if (!existsSync(filePath)) {
      return null;
    }
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (err) {
    console.error(`Failed to load ${filename}:`, err);
    return null;
  }
}

/**
 * Clear a data file (for testing)
 */
export function clearFile(filename: string): void {
  try {
    const filePath = getFilePath(filename);
    if (existsSync(filePath)) {
      writeFileSync(filePath, "null", "utf-8");
    }
  } catch (err) {
    console.error(`Failed to clear ${filename}:`, err);
  }
}
