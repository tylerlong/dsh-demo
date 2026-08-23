/**
 * test-setup.ts — vitest setup for the web component tests.
 *
 * Loads @testing-library/jest-dom's vitest matchers (toBeDisabled,
 * toBeEnabled, toHaveValue, toHaveTextContent, ...) so the component tests
 * can assert on the DOM the way a user sees it, and unmounts every rendered
 * component after each test (testing-library's auto-cleanup only runs when
 * vitest globals are enabled, which this repo deliberately keeps off).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
	cleanup();
});
