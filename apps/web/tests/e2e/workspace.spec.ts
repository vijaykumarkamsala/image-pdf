import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_SCHEMA_VERSION, type ProcessingJobRecord } from "ipw-contracts-ts/product";

async function identify(page: Page, suffix: string, theme: "light" | "dark" = "light") {
  const id = `actor-${suffix}`;
  await page.addInitScript(({ actorId, selectedTheme }) => {
    localStorage.setItem("ipw-theme", selectedTheme);
    sessionStorage.setItem("ipw-bootstrap-key", `bootstrap-${actorId}`);
  }, { actorId: id, selectedTheme: theme });
  const csrf = await page.evaluate(() => document.cookie.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("ipw-csrf="))?.slice("ipw-csrf=".length) ?? null).catch(() => null);
  const response = await page.request.post("/v1/auth/developer-session", {
    headers: csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : undefined,
    data: { actor_id: id, display_name: "Alex Morgan" },
  });
  expect(response.ok()).toBe(true);
}

async function openWorkspace(page: Page, suffix: string, theme: "light" | "dark" = "light") {
  await identify(page, suffix, theme);
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
}

async function routeDeterministicOidcSignIn(page: Page, code: string) {
  await page.route("**/v1/auth/login**", async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const authorizationUrl = response.headers()["location"];
    const state = authorizationUrl ? new URL(authorizationUrl).searchParams.get("state") : null;
    await route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:4173/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? "")}`,
      },
    });
  });
}

async function clearFocus(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const screenshotOptions = {
  animations: "disabled",
  caret: "hide",
  scale: "css",
  maxDiffPixelRatio: 0,
} as const;

async function prepareVisualScreenshot(page: Page) {
  await expect(page.locator("body")).not.toContainText(/recovery/i);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await clearFocus(page);
}

test("real API onboarding, project creation, and Default Files journey", async ({ page }) => {
  await openWorkspace(page, "journey");
  await expect(page.getByRole("button", { name: "Choose workspace" })).toHaveCount(0);
  await page.getByRole("link", { name: "Projects" }).first().click();
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Retail launch");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Retail launch" })).toBeVisible();
  await page.getByRole("link", { name: "Files" }).first().click();
  await expect(page.getByRole("heading", { name: "Default Files" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No files yet" })).toBeVisible();
  await expect(page.getByText("Files you upload, create or save without a project will appear here.")).toBeVisible();
});

test("canonical workspace URLs survive refresh and reject another tenant", async ({ page }) => {
  await openWorkspace(page, "canonical-owner");
  await page.getByRole("link", { name: "Projects" }).first().click();
  const ownerUrl = page.url();
  await page.reload();
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await page.getByRole("button", { name: "Account for Alex Morgan" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("guest-home")).toBeVisible();
  await identify(page, "canonical-other");
  await page.goto(ownerUrl);
  await expect(page.getByRole("heading", { name: "Workspace access denied" })).toBeVisible();
  await expect(page.getByTestId("projects-page")).toHaveCount(0);
  expect(page.url()).toBe(ownerUrl);
});

test("every customer route hard-refreshes through the production preview", async ({ page }) => {
  await openWorkspace(page, "route-refresh");
  const workspaceId = new URL(page.url()).pathname.split("/")[2]!;
  const routes = [
    [`/w/${workspaceId}`, "workspace-home"],
    [`/w/${workspaceId}/projects`, "projects-page"],
    [`/w/${workspaceId}/files`, "files-page"],
    [`/w/${workspaceId}/jobs`, "jobs-page"],
  ] as const;
  for (const [route, testId] of routes) {
    await page.goto(route);
    await page.reload();
    await expect(page.getByTestId(testId)).toBeVisible();
    expect(page.url()).toContain(route);
  }
  await page.goto("/app");
  await page.reload();
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.goto("/guest/upload");
  await page.reload();
  await expect(page.getByTestId("guest-home")).toBeVisible();
});

test("workspace selector lists permitted workspaces and uses canonical URLs", async ({ page }) => {
  await identify(page, "workspace-selector");
  const listed = await page.request.get("/v1/me/workspaces").then((response) => response.json()) as { schema_version: string; workspaces: Array<Record<string, unknown>> };
  const current = listed.workspaces[0];
  const currentId = String(current["workspace_id"]);
  const currentContext = await page.request.get(`/v1/workspaces/${currentId}/context`).then((response) => response.json()) as Record<string, any>;
  const currentHome = await page.request.get(`/v1/workspaces/${currentId}/home`).then((response) => response.json()) as Record<string, unknown>;
  const secondId = "workspace-permitted-second";
  const secondName = "Production team with a complete workspace name";
  const second = { ...current, workspace_id: secondId, name: secondName, personal_for_actor_id: null };
  const secondContext = {
    ...currentContext,
    workspace: second,
    membership: { ...currentContext["membership"], membership_id: "membership-permitted-second", workspace_id: secondId, role: "member" },
    policy: { ...currentContext["policy"], workspace_id: secondId },
    default_files: { ...currentContext["default_files"], default_files_id: "default-files-permitted-second", workspace_id: secondId },
  };
  const secondHome = JSON.parse(JSON.stringify(currentHome).replaceAll(currentId, secondId)) as Record<string, unknown>;
  await page.route("**/v1/me/workspaces", (route) => route.fulfill({ json: { ...listed, workspaces: [current, second] } }));
  await page.route(`**/v1/workspaces/${secondId}/context`, (route) => route.fulfill({ json: secondContext }));
  await page.route(`**/v1/workspaces/${secondId}/home`, (route) => route.fulfill({ json: secondHome }));

  await page.goto(`/w/${currentId}`);
  await page.getByRole("button", { name: /Choose workspace/ }).click();
  await expect(page.getByRole("group", { name: "Available workspaces" }).getByText(secondName)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: new RegExp(secondName) }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${secondId}$`));
  await expect(page.locator(".header-workspace strong")).toHaveText(secondName);
  await expect(page.locator(".header-workspace strong")).toHaveAttribute("title", secondName);
  await expect(page.locator(".workspace-switcher-content strong")).toHaveAttribute("title", secondName);
});

test("real API secure upload becomes a preserved Default Files source", async ({ page }) => {
  await openWorkspace(page, "upload-journey");
  await page.getByRole("button", { name: "Upload" }).first().click();
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(page.getByText("synthetic-alpha-32.png")).toBeVisible();
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "synthetic-alpha-32.png" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("PNG image")).toBeVisible();
  await expect(page.getByText("Passed safety checks", { exact: true })).toBeVisible();
  await expect(page.getByText("<0.01 MP")).toBeVisible();
  await expect(page.getByText("SHA-256")).not.toBeVisible();
  await page.getByText("Advanced details").click();
  await expect(page.getByText("SHA-256")).toBeVisible();
  await expect(page.getByText("Likely", { exact: true })).toBeVisible();
  await expect(page.getByText("No visual quality assessment was performed during intake.")).toBeVisible();
  await expect(page.getByText(/Not assessed by intake/)).toBeVisible();
  await expect(page.getByText("This recommendation does not alter or process your source.")).toBeVisible();
  await page.getByLabel("Correct source category").selectOption("document");
  await expect(page.locator(".intake-recommendation").getByText("Create PDF", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/4K quality|8K quality|Recreate|AI enhancement/i);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.locator(".upload-actions").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Files" }).first().click();
  await expect(page.getByRole("heading", { name: "Default Files" })).toBeVisible();
  await expect(page.getByText("synthetic-alpha-32.png")).toBeVisible();
  await expect(page.locator(".testing-status")).toContainText(/1 file.*1 job/);
});

test("real workspace search, notifications, and durable Jobs use server state", async ({ page }) => {
  await openWorkspace(page, "workspace-operations");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Searchable campaign");
  await page.getByRole("button", { name: "Create project" }).click();

  await page.keyboard.press("Control+K");
  const searchInput = page.getByLabel("Search projects, files and jobs");
  await searchInput.fill("Searchable");
  const searchResult = page.getByRole("button", { name: /Searchable campaign/ });
  await expect(searchResult).toBeVisible();
  await expect(searchResult.locator(".ds-badge")).toHaveText("Project");
  await expect(searchResult.locator("small")).toHaveCount(0);
  await searchInput.press("Tab");
  await expect(searchResult).toBeFocused();
  expect(await searchResult.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await searchResult.press("Enter");
  await expect(page.getByTestId("projects-page")).toBeVisible();

  await page.getByRole("link", { name: "Home" }).first().click();
  await page.getByRole("button", { name: "Upload" }).first().click();
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  await page.locator(".upload-actions").getByRole("button", { name: "Close", exact: true }).click();

  const notificationButton = page.getByRole("button", { name: /unread notifications/ });
  await expect(notificationButton).toBeVisible();
  await notificationButton.click();
  await expect(page.locator(".notification-popover").getByText("File accepted")).toBeVisible();
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByText("You're up to date")).toBeVisible();

  await page.getByRole("link", { name: "Jobs" }).first().click();
  await page.getByRole("tab", { name: "Completed" }).click();
  const completedJob = page.locator(".job-card").first();
  await expect(completedJob.getByRole("heading", { name: "File intake check" })).toBeVisible();
  const jobId = await completedJob.getAttribute("data-job-id");
  expect(jobId).toBeTruthy();
  const workspaceId = new URL(page.url()).pathname.split("/")[2];
  await page.goto(`/w/${workspaceId}/jobs?view=completed&job=${jobId}`);
  await expect(page.getByRole("region", { name: "Ordered job timeline" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("notification pagination appends durable pages and announces the result", async ({ page }) => {
  await identify(page, "notification-pagination");
  const listed = await page.request.get("/v1/me/workspaces").then((response) => response.json()) as { workspaces: Array<{ workspace_id: string }> };
  const workspaceId = listed.workspaces[0]!.workspace_id;
  const notification = (index: number) => ({
    schema_version: PRODUCT_SCHEMA_VERSION,
    notification_id: `notification-page-${index}`,
    workspace_id: workspaceId,
    kind: "upload_accepted",
    title: `Accepted file ${index}`,
    message: `source-${index}.png`,
    resource_kind: "upload_session",
    resource_id: `upload-page-${index}`,
    occurred_at: `2026-08-30T00:${String(59 - index).padStart(2, "0")}:00.000Z`,
    read_at: null,
  });
  await page.route(`**/v1/workspaces/${workspaceId}/notifications?**`, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    route.fulfill({ json: cursor
      ? { schema_version: PRODUCT_SCHEMA_VERSION, notifications: [notification(13)], next_cursor: null, unread_count: 13 }
      : { schema_version: PRODUCT_SCHEMA_VERSION, notifications: Array.from({ length: 12 }, (_, index) => notification(index + 1)), next_cursor: "older-page", unread_count: 13 } });
  });

  await page.goto(`/w/${workspaceId}`);
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.getByRole("button", { name: "13 unread notifications" }).click();
  await expect(page.locator(".notification-list > button")).toHaveCount(12);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".notification-list > button")).toHaveCount(13);
  await expect(page.getByRole("status")).toHaveText("1 older notification loaded.");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("an in-flight upload can be cancelled and its temporary source is removed", async ({ page }) => {
  let releaseTransfer: (() => void) | undefined;
  await page.route("**/v1/uploads/**", async (route) => {
    await new Promise<void>((resolve) => { releaseTransfer = resolve; });
    await route.abort().catch(() => undefined);
  });
  await openWorkspace(page, "upload-cancel");
  await page.getByRole("button", { name: "Upload" }).first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "cancelled.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(4096, 1),
  });
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("Uploading securely")).toBeVisible();
  await page.getByTitle("Cancel cancelled.png").click();
  await expect(page.getByText("Upload cancelled")).toBeVisible();
  releaseTransfer?.();
});

test("multiple files keep completed and failed states isolated", async ({ page }) => {
  await openWorkspace(page, "upload-multiple");
  await page.getByRole("button", { name: "Upload" }).first().click();
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "synthetic-alpha-32.png", mimeType: "image/png", buffer: readFileSync(fixture) },
    { name: "unsupported.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") },
  ]);
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Upload 2" }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Choose a supported image or PDF file/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("an interrupted transfer resumes the same file after browser refresh", async ({ page }) => {
  let releaseTransfer: (() => void) | undefined;
  let markTransferStarted: (() => void) | undefined;
  const transferStarted = new Promise<void>((resolve) => { markTransferStarted = resolve; });
  await page.route("**/v1/uploads/**", async (route) => {
    markTransferStarted?.();
    await new Promise<void>((resolve) => { releaseTransfer = resolve; });
    await route.abort().catch(() => undefined);
  });
  await openWorkspace(page, "upload-refresh");
  await page.getByRole("button", { name: "Upload" }).first().click();
  const file = {
    name: "resume.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(4096, 1),
  };
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("Uploading securely")).toBeVisible();
  await transferStarted;
  releaseTransfer?.();
  await expect(page.getByText("The file transfer was interrupted")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Choose the same file to resume")).toBeVisible();
  await page.unroute("**/v1/uploads/**");
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("Ready to resume from the verified upload position.")).toBeVisible();
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("File not accepted")).toBeVisible({ timeout: 15_000 });
});

test("guest upload signs in to save the exact accepted source", async ({ page, context }) => {
  await routeDeterministicOidcSignIn(page, "code-guest-customer");
  await page.goto("/guest/upload");
  await expect(page.getByTestId("guest-home")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.cookie)).toContain("ipw-csrf=");
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/expire after 24 hours/)).toBeVisible();
  const guestState = await page.evaluate(() => sessionStorage.getItem("ipw-guest-session"));
  expect(guestState).toContain("guestSessionId");
  expect(guestState).not.toContain("token");
  const otherTab = await context.newPage();
  await otherTab.goto("/guest/upload");
  await expect(otherTab.getByTestId("guest-home")).toBeVisible();
  await page.getByRole("button", { name: "Sign in to save" }).click();
  await expect(page.getByRole("heading", { name: "Default Files" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("synthetic-alpha-32.png")).toBeVisible();
  await expect(otherTab.getByRole("heading", { name: "Default Files" })).toBeVisible({ timeout: 15_000 });
  await expect(otherTab.getByText("synthetic-alpha-32.png")).toBeVisible();
});

test("duplicate guest tabs recover from server state without sharing credentials", async ({ page, context }) => {
  await page.goto("/guest/upload");
  await expect(page.getByTestId("guest-home")).toBeVisible();
  const otherTab = await context.newPage();
  await otherTab.goto("/guest/upload");
  await expect(otherTab.getByTestId("guest-home")).toBeVisible();
  const [firstGuest, secondGuest] = await Promise.all([
    page.evaluate(() => sessionStorage.getItem("ipw-guest-session")),
    otherTab.evaluate(() => sessionStorage.getItem("ipw-guest-session")),
  ]);
  expect(firstGuest).toBe(secondGuest);

  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  await expect(otherTab.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  const sharedReferences = await otherTab.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith("ipw-active-uploads-")));
  expect(JSON.stringify(sharedReferences)).not.toMatch(/token|authorization|resumable|uri|https?:/i);
  await page.close();
  await otherTab.reload();
  await expect(otherTab.getByText("File ready")).toBeVisible({ timeout: 15_000 });
});

test("account logout revokes the session and clears private browser state", async ({ page, context }) => {
  await openWorkspace(page, "logout");
  const otherTab = await context.newPage();
  await otherTab.goto(page.url());
  await expect(otherTab.getByTestId("workspace-home")).toBeVisible();
  await page.evaluate(async () => {
    sessionStorage.setItem("ipw-private-test", "private");
    localStorage.setItem("ipw-private-test", "private");
    const cache = await caches.open("ipw-private-test");
    await cache.put("/private-test", new Response("private"));
  });
  await page.getByRole("button", { name: "Account for Alex Morgan" }).click();
  await expect(page.getByText("Session active")).toBeVisible();
  await expect(page.locator(".account-popover")).toContainText(/owner in Alex Morgan's workspace/i);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("guest-home")).toBeVisible();
  await expect(otherTab.getByTestId("guest-home")).toBeVisible();
  expect(await page.request.get("/v1/auth/session").then((response) => response.json())).toEqual({ authenticated: false });
  const cleared = await page.evaluate(async () => ({
    session: sessionStorage.getItem("ipw-private-test"),
    local: localStorage.getItem("ipw-private-test"),
    theme: localStorage.getItem("ipw-theme"),
    caches: "caches" in window ? await caches.keys() : [],
  }));
  expect(cleared).toMatchObject({ session: null, local: null, theme: "light" });
  expect(cleared.caches).toEqual(["ipw-shell-2c-v2"]);
  expect(cleared.caches.some((name) => name.startsWith("ipw-private-"))).toBe(false);
});

test("guest upload has no detectable accessibility violations", async ({ page }) => {
  await page.goto("/guest/upload");
  await expect(page.getByTestId("guest-home")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("returning guests can sign in through the existing BFF journey", async ({ page }) => {
  await routeDeterministicOidcSignIn(page, "code-returning-customer");
  await page.goto("/guest/upload");
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible();
  await signIn.click();
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
});

test("guest upload shows one clear action only after file selection", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/guest/upload");
  await expect(page.getByTestId("guest-home")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Upload \d+ files?$/ })).toHaveCount(0);
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  const upload = page.getByRole("button", { name: "Upload 1 file", exact: true });
  await expect(upload).toBeEnabled();
  expect((await upload.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("button", { name: "Upload files", exact: true })).toHaveCount(0);
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
});

test("customer copy discloses testing and inactive product areas without internal or monetary language", async ({ page }) => {
  await openWorkspace(page, "customer-copy");
  const testingStatus = page.locator(".testing-status");
  await expect(testingStatus).toContainText("Free during testing");
  await expect(testingStatus).toContainText(/0 files.*0 jobs/);
  await expect(testingStatus).not.toContainText(/\$|price|credit/i);

  const expectedOutcomes = [
    ["Image & Graphic Studio", "Enhance, design and prepare visuals"],
    ["Create PDF", "Build PDFs from pages, images and rich content"],
    ["Edit & Manage PDF", "Edit, organize, protect and convert PDFs"],
    ["Print & Production", "Check quality and prepare production outputs"],
  ] as const;
  const tiles = page.locator(".outcome-card");
  await expect(tiles).toHaveCount(4);
  for (const [label, description] of expectedOutcomes) {
    const tile = tiles.filter({ hasText: label });
    await expect(tile).toContainText(description);
    await expect(tile).toHaveAttribute("data-feature-state", "inactive");
    await expect(tile).toHaveAttribute("aria-disabled", "true");
    await expect(tile).not.toContainText("Not active in this build");
  }
  await expect(page.getByText("Available in a later recovery")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/recovery/i);
  await expect(tiles.locator("a, button")).toHaveCount(0);
  expect(await tiles.evaluateAll((elements) => elements.every((element) => (element as HTMLElement).tabIndex === -1))).toBe(true);
});

test("loading, access-denied, and API error states are customer-safe", async ({ page }) => {
  let release: (() => void) | undefined;
  await page.route("**/v1/session/bootstrap", async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "access-denied", message: "You do not have access to this workspace" } }),
    });
  });
  await identify(page, "denied");
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Opening your workspace" })).toBeVisible();
  release?.();
  await expect(page.getByRole("heading", { name: "Workspace access denied" })).toBeVisible();
  await expect(page.getByText("You do not have access to this workspace")).toBeVisible();
});

for (const route of ["home", "projects", "files", "jobs"] as const) {
  test(`${route} journey has no detectable accessibility violations`, async ({ page }) => {
    await openWorkspace(page, `axe-${route}`);
    if (route !== "home") await page.getByRole("link", { name: route === "projects" ? "Projects" : route === "files" ? "Files" : "Jobs" }).first().click();
    await expect(page.locator("main")).not.toHaveAttribute("aria-busy", "true");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}

test("collapsed tablet navigation retains accessible names", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openWorkspace(page, "axe-tablet-navigation");
  const primaryNavigation = page.getByRole("navigation", { name: "Workspace navigation" }).first();
  for (const name of ["Home", "Projects", "Files", "Jobs"]) {
    await expect(primaryNavigation.getByRole("link", { name })).toBeVisible();
  }
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("phone navigation remains operable without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page, "phone-nav");
  await page.getByTitle("Open navigation").click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Projects" }).last().click();
  await expect(page.getByTestId("projects-page")).toBeVisible();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
});

test("phone controls preserve 44 pixel interaction targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page, "phone-targets");
  await page.getByRole("button", { name: "Upload" }).first().click();
  await expect(page.getByRole("dialog", { name: "Upload files" })).toBeVisible();
  const undersized = await page.locator('button:not([disabled]), a[href], [role="button"], [role="menuitem"], [role="tab"], label.ds-dropzone, select').evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
    })
    .map((element) => {
      const bounds = element.getBoundingClientRect();
      return { label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName, width: bounds.width, height: bounds.height };
    })
    .filter((target) => target.width < 44 || target.height < 44));
  expect(undersized).toEqual([]);
});

test("offline status is truthful and accessible", async ({ page }) => {
  await openWorkspace(page, "offline-status");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  const status = page.getByRole("status").filter({ hasText: "You are offline" });
  await expect(status).toContainText("New uploads and online processing require a connection");
  await expect(status).toContainText("Interrupted uploads can resume when you reconnect");
  await expect(status).toContainText("work already accepted by the server remains durable");
  await expect(status).not.toContainText(/processing continues|upload continues/i);
  await page.getByRole("button", { name: "Collapse offline message" }).click();
  const indicator = page.getByRole("status").filter({ hasText: "Offline" });
  await expect(indicator).toBeVisible();
  await expect(page.getByRole("button", { name: "Show offline details" })).toBeVisible();
  await page.getByRole("button", { name: "Show offline details" }).click();
  await expect(page.getByRole("status").filter({ hasText: "You are offline" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("internal panel harness restores, constrains, persists and resets layout", async ({ page }) => {
  await page.goto("/internal/panels");
  await expect(page.getByRole("heading", { name: "Panel framework" })).toBeVisible();
  const panel = page.locator('[data-panel-id="inspector"]');
  await panel.getByRole("button", { name: "Panel position" }).click();
  await page.getByRole("menuitem", { name: "Dock bottom" }).click();
  await expect(panel).toHaveClass(/dock-bottom/);
  await panel.getByRole("button", { name: "Panel position" }).click();
  await page.getByRole("menuitem", { name: "Dock right" }).click();
  await expect(panel).toHaveClass(/dock-right/);
  await panel.getByRole("button", { name: "Panel position" }).click();
  await page.getByRole("menuitem", { name: "Detach panel" }).click();
  await expect(panel).toHaveClass(/dock-floating/);

  const header = panel.locator(".panel-window-header");
  const pointerStart = await panel.boundingBox();
  const headerBox = await header.boundingBox();
  expect(pointerStart).not.toBeNull();
  expect(headerBox).not.toBeNull();
  await page.mouse.move(headerBox!.x + 24, headerBox!.y + headerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(headerBox!.x + 64, headerBox!.y + headerBox!.height / 2 + 24, { steps: 4 });
  await page.mouse.up();
  const pointerMoved = await panel.boundingBox();
  expect(pointerMoved!.x).toBeGreaterThan(pointerStart!.x);
  expect(pointerMoved!.y).toBeGreaterThan(pointerStart!.y);

  const resizeHandle = panel.getByRole("button", { name: "Resize panel" });
  const resizeStart = await panel.boundingBox();
  const resizeBox = await resizeHandle.boundingBox();
  expect(resizeBox).not.toBeNull();
  await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox!.x + resizeBox!.width / 2 + 36, resizeBox!.y + resizeBox!.height / 2 + 28, { steps: 4 });
  await page.mouse.up();
  const pointerResized = await panel.boundingBox();
  expect(pointerResized!.width).toBeGreaterThan(resizeStart!.width);
  expect(pointerResized!.height).toBeGreaterThan(resizeStart!.height);

  await header.focus();
  const before = await panel.evaluate((element) => element.getBoundingClientRect().left);
  const widthBefore = await panel.evaluate((element) => element.getBoundingClientRect().width);
  await page.keyboard.press("ArrowRight");
  const after = await panel.evaluate((element) => element.getBoundingClientRect().left);
  expect(after).toBeGreaterThan(before);
  await page.keyboard.press("Shift+ArrowRight");
  const widthAfter = await panel.evaluate((element) => element.getBoundingClientRect().width);
  expect(widthAfter).toBeGreaterThan(widthBefore);
  await panel.getByTitle("Collapse panel").click();
  await expect(panel).toHaveClass(/is-collapsed/);
  await panel.getByTitle("Expand panel").click();

  await panel.getByTitle("Pin panel").click();
  await expect(panel.getByTitle("Close panel")).toBeDisabled();
  await panel.getByTitle("Unpin panel").click();
  await panel.getByTitle("Close panel").click();
  const launcher = page.getByRole("button", { name: "Open Layout fixture" });
  await expect(launcher).toBeFocused();
  await page.reload();
  await expect(launcher).toBeVisible();
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect(panel).toHaveClass(/dock-left/);

  await page.setViewportSize({ width: 768, height: 1024 });
  const tabletBounds = await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
  });
  expect(tabletBounds.left).toBeGreaterThanOrEqual(0);
  expect(tabletBounds.right).toBeLessThanOrEqual(768);
  expect(tabletBounds.top).toBeGreaterThanOrEqual(0);
  expect(tabletBounds.bottom).toBeLessThanOrEqual(1024);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Secondary fixture" }).click();
  await expect(page.locator('[data-panel-id="conversation"]')).toHaveClass(/is-active/);
  const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("service worker upgrades shell state, avoids API caching, clears private caches and serves offline fallback", async ({ page, context }) => {
  await page.goto("/offline.html");
  await page.evaluate(async () => {
    await caches.open("ipw-shell-obsolete");
    await caches.open("ipw-private-pre-activation");
  });
  const documentResponse = await page.goto("/");
  const csp = documentResponse?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  expect(manifestResponse.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = await manifestResponse.json() as { name: string; start_url: string; scope: string; display: string; icons: Array<{ src: string; purpose: string }> };
  expect(manifest).toMatchObject({ name: "Visual Workspace", start_url: "/", scope: "/", display: "standalone" });
  expect(manifest.icons.map((icon) => icon.purpose)).toEqual(["any", "maskable"]);
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    await registration.update();
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const version = await page.evaluate(() => new Promise<string>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data.version);
    navigator.serviceWorker.controller!.postMessage({ type: "GET_VERSION" }, [channel.port2]);
  }));
  expect(version).toBe("ipw-shell-2c-v2");
  const apiResponse = await page.request.get("/v1/health");
  expect(apiResponse.headers()["cache-control"]).toBe("no-store, max-age=0");
  await page.evaluate(async () => {
    await caches.open("ipw-private-logout-proof");
    navigator.serviceWorker.controller!.postMessage({ type: "CLEAR_PRIVATE_CACHES" });
  });
  await expect.poll(() => page.evaluate(async () => !(await caches.keys()).includes("ipw-private-logout-proof"))).toBe(true);
  const cacheEvidence = await page.evaluate(async () => ({
    names: await caches.keys(),
    requests: (await Promise.all((await caches.keys()).map(async (name) => (await caches.open(name)).keys()))).flat().map((request) => request.url),
  }));
  expect(cacheEvidence.names).not.toContain("ipw-shell-obsolete");
  expect(cacheEvidence.names).not.toContain("ipw-private-pre-activation");
  expect(cacheEvidence.requests.some((url) => new URL(url).pathname.startsWith("/v1/"))).toBe(false);

  await context.setOffline(true);
  await page.goto("/offline-proof");
  await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/recovery/i);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await context.setOffline(false);
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} keyboard focus uses the accessible brand token`, async ({ page }) => {
    await openWorkspace(page, `focus-${theme}`, theme);
    await page.keyboard.press("Tab");
    const focus = page.locator(":focus");
    await expect(focus).toBeVisible();
    const styles = await focus.evaluate((element) => {
      const computed = getComputedStyle(element);
      const root = getComputedStyle(document.documentElement);
      return {
        outlineColor: computed.outlineColor,
        outlineStyle: computed.outlineStyle,
        outlineWidth: computed.outlineWidth,
        focusToken: root.getPropertyValue("--focus-ring").trim(),
        errorToken: root.getPropertyValue("--error").trim(),
      };
    });
    expect(styles).toEqual({
      outlineColor: theme === "light" ? "rgb(18, 99, 214)" : "rgb(155, 179, 255)",
      outlineStyle: "solid",
      outlineWidth: "3px",
      focusToken: theme === "light" ? "#1263d6" : "#9bb3ff",
      errorToken: theme === "light" ? "#b23d47" : "#ff99a1",
    });
    expect(styles.focusToken).not.toBe(styles.errorToken);
  });
}

const visualCases = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "intermediate", width: 638, height: 768 },
  { name: "phone", width: 390, height: 844 },
] as const;

test("@visual desktop light Guest Home", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/guest/upload");
  await expect(page.getByTestId("guest-home")).toBeVisible();
  await expect(page.locator("label.ds-dropzone")).toBeVisible();
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("guest-home-1440x900-light.png", screenshotOptions);
});

test("@visual phone light Guest Home", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/guest/upload");
  await expect(page.getByTestId("guest-home")).toBeVisible();
  await expect(page.locator("label.ds-dropzone")).toBeVisible();
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("guest-home-390x844-light.png", screenshotOptions);
});

test("@visual tablet dark Guest intake result", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.addInitScript(() => localStorage.setItem("ipw-theme", "dark"));
  await page.goto("/guest/upload");
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Likely", { exact: true })).toBeVisible();
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("guest-intake-ready-768x1024-dark.png", screenshotOptions);
});

test("@visual desktop light populated signed-in Home", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page, "visual-populated-home");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Retail launch");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("link", { name: "Home" }).first().click();
  await expect(page.getByText("Retail launch")).toBeVisible();
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("workspace-home-populated-1440x900-light.png", screenshotOptions);
});

test("@visual tablet dark mixed-state Jobs", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openWorkspace(page, "visual-mixed-jobs", "dark");
  await page.getByRole("button", { name: "Upload" }).first().click();
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  await page.locator(".upload-actions").getByRole("button", { name: "Close", exact: true }).click();
  const workspaceId = new URL(page.url()).pathname.split("/")[2]!;
  const listed = await page.request.get(`/v1/workspaces/${workspaceId}/jobs?view=all&limit=25`).then((response) => response.json()) as { jobs: ProcessingJobRecord[] };
  const completed = listed.jobs[0]!;
  const jobs: ProcessingJobRecord[] = [
    { ...completed, job_id: "job-visual-running", state: "running", progress_percent: 42, failure: null },
    { ...completed, job_id: "job-visual-failed", state: "failed", progress_percent: 64, failure: { schema_version: PRODUCT_SCHEMA_VERSION, code: "inspection-timeout", message: "The file check timed out and can be tried again.", retryable: true } },
    { ...completed, job_id: "job-visual-cancelled", state: "cancelled", progress_percent: 25, failure: null },
    completed,
  ];
  await page.route(`**/v1/workspaces/${workspaceId}/jobs?**`, (route) => route.fulfill({ json: { schema_version: PRODUCT_SCHEMA_VERSION, jobs, next_cursor: null } }));
  await page.goto(`/w/${workspaceId}/jobs?view=all`);
  await expect(page.locator(".job-card")).toHaveCount(4);
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("workspace-jobs-mixed-768x1024-dark.png", screenshotOptions);
});

test("@visual intermediate light open Search", async ({ page }) => {
  await page.setViewportSize({ width: 638, height: 768 });
  await openWorkspace(page, "visual-open-search");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Searchable campaign");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.keyboard.press("Control+K");
  await page.getByLabel("Search projects, files and jobs").fill("Searchable");
  await expect(page.getByRole("button", { name: /Searchable campaign/ })).toBeVisible();
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("workspace-search-open-638x768-light.png", screenshotOptions);
});

test("@visual phone dark Notifications with pagination", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await identify(page, "visual-paginated-notifications", "dark");
  const listed = await page.request.get("/v1/me/workspaces").then((response) => response.json()) as { workspaces: Array<{ workspace_id: string }> };
  const workspaceId = listed.workspaces[0]!.workspace_id;
  const notification = (index: number) => ({
    schema_version: PRODUCT_SCHEMA_VERSION,
    notification_id: `visual-notification-${index}`,
    workspace_id: workspaceId,
    kind: "upload_accepted",
    title: `File accepted ${index}`,
    message: `campaign-source-${index}.png`,
    resource_kind: "upload_session",
    resource_id: `visual-upload-${index}`,
    occurred_at: `2026-08-30T00:${String(59 - index).padStart(2, "0")}:00.000Z`,
    read_at: null,
  });
  await page.route(`**/v1/workspaces/${workspaceId}/notifications?**`, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({ json: cursor
      ? { schema_version: PRODUCT_SCHEMA_VERSION, notifications: [notification(4)], next_cursor: null, unread_count: 4 }
      : { schema_version: PRODUCT_SCHEMA_VERSION, notifications: Array.from({ length: 3 }, (_, index) => notification(index + 1)), next_cursor: "older-page", unread_count: 4 } });
  });
  await page.goto(`/w/${workspaceId}`);
  await page.getByRole("button", { name: "4 unread notifications" }).click();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("status")).toHaveText("1 older notification loaded.");
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("workspace-notifications-paginated-390x844-dark.png", screenshotOptions);
});

test("@visual intermediate dark offline state", async ({ page }) => {
  await page.setViewportSize({ width: 638, height: 768 });
  await openWorkspace(page, "visual-offline-state", "dark");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByRole("status").filter({ hasText: "You are offline" })).toBeVisible();
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("workspace-offline-638x768-dark.png", screenshotOptions);
});

test("@visual intermediate dark collapsed offline state", async ({ page }) => {
  await page.setViewportSize({ width: 638, height: 768 });
  await openWorkspace(page, "visual-collapsed-offline-state", "dark");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.getByRole("button", { name: "Collapse offline message" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Offline" })).toBeVisible();
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("workspace-offline-collapsed-638x768-dark.png", screenshotOptions);
});

test("@visual phone light account menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page, "visual-account-menu");
  await page.getByRole("button", { name: "Account for Alex Morgan" }).click();
  await expect(page.getByText("Session active")).toBeVisible();
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("workspace-account-menu-390x844-light.png", screenshotOptions);
});

test("@visual tablet light multiple-workspace selector", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await identify(page, "visual-workspace-selector");
  const listed = await page.request.get("/v1/me/workspaces").then((response) => response.json()) as { schema_version: string; workspaces: Array<Record<string, unknown>> };
  const current = listed.workspaces[0]!;
  const currentId = String(current["workspace_id"]);
  const second = { ...current, workspace_id: "workspace-visual-team", name: "Production team", personal_for_actor_id: null };
  await page.route("**/v1/me/workspaces", (route) => route.fulfill({ json: { ...listed, workspaces: [current, second] } }));
  await page.goto(`/w/${currentId}`);
  await page.getByRole("button", { name: "Choose workspace" }).click();
  await expect(page.getByRole("group", { name: "Available workspaces" }).getByText("Production team")).toBeVisible();
  await prepareVisualScreenshot(page);
  await expect(page).toHaveScreenshot("workspace-selector-768x1024-light.png", screenshotOptions);
});

for (const viewport of visualCases) {
  for (const theme of ["light", "dark"] as const) {
    test(`@visual ${viewport.name} ${theme} workspace home`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openWorkspace(page, `visual-${viewport.name}-${theme}`, theme);
      await expect(page).toHaveScreenshot(`workspace-home-${viewport.width}x${viewport.height}-${theme}.png`, screenshotOptions);
    });
  }
}

for (const viewport of visualCases) {
  for (const theme of ["light", "dark"] as const) {
    test(`@visual ${viewport.name} ${theme} selected upload dialog`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openWorkspace(page, `visual-upload-${viewport.name}-${theme}`, theme);
      await page.getByRole("button", { name: "Upload" }).first().click();
      await page.locator('input[type="file"]').setInputFiles({
        name: "visual-proof.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(1536, 1),
      });
      await expect(page.getByText("visual-proof.png")).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(accessibility.violations).toEqual([]);
      await clearFocus(page);
      await expect(page).toHaveScreenshot(
        `workspace-upload-selected-${viewport.width}x${viewport.height}-${theme}.png`,
        screenshotOptions,
      );
    });
  }
}

test("@visual tablet light Projects", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openWorkspace(page, "visual-tablet-projects");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-projects-768x1024-light.png", screenshotOptions);
});

test("@visual 638x768 Projects keeps its header action on one line", async ({ page }) => {
  await page.setViewportSize({ width: 638, height: 768 });
  await openWorkspace(page, "visual-projects-638");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();

  const action = page.getByRole("button", { name: "New project" }).first();
  const layout = await action.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      height: bounds.height,
      whiteSpace: getComputedStyle(element).whiteSpace,
      contentFits: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.height).toBeGreaterThanOrEqual(44);
  expect(layout.whiteSpace).toBe("nowrap");
  expect(layout.contentFits).toBe(true);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-projects-638x768-light.png", screenshotOptions);
});

test("@visual phone light Home with navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page, "visual-phone-navigation");
  await page.getByTitle("Open navigation").click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await expect(page).toHaveScreenshot("workspace-home-navigation-390x844-light.png", screenshotOptions);
});

test("@visual phone light Default Files", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page, "visual-phone-files");
  await page.locator(".phone-bottom-nav").getByRole("link", { name: "Files" }).click();
  await expect(page.getByRole("heading", { name: "No files yet" })).toBeVisible();
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-files-390x844-light.png", screenshotOptions);
});

test("@visual desktop light Projects with one created project", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page, "visual-created-project");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Retail launch");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Retail launch" })).toBeVisible();
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-projects-created-1440x900-light.png", screenshotOptions);
});

test("@visual desktop dark verified intelligent intake", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page, "visual-intake-ready", "dark");
  await page.getByRole("button", { name: "Upload" }).first().click();
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "synthetic-alpha-32.png" })).toBeVisible({ timeout: 15_000 });
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-intake-ready-1440x900-dark.png", screenshotOptions);
});

test("@visual desktop light completed Jobs", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page, "visual-completed-jobs");
  await page.getByRole("button", { name: "Upload" }).first().click();
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  await page.locator(".upload-actions").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Jobs" }).first().click();
  await page.getByRole("tab", { name: "Completed" }).click();
  await expect(page.getByRole("heading", { name: "File intake check" })).toBeVisible();
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-jobs-completed-1440x900-light.png", screenshotOptions);
});

test("@visual phone dark notification center", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page, "visual-phone-notifications", "dark");
  await page.getByRole("button", { name: "Upload" }).first().click();
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await page.getByRole("button", { name: "Upload 1" }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 15_000 });
  await page.locator(".upload-actions").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /unread notifications/ }).click();
  await expect(page.locator(".notification-popover")).toBeVisible();
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-notifications-390x844-dark.png", screenshotOptions);
});
