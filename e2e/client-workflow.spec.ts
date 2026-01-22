import { test, expect } from '@playwright/test';

test.describe('Client Workflow', () => {
  let accessLinkUrl: string;
  let familyName: string;

  test.beforeAll(async ({ browser }) => {
    // Admin creates a family and TWO access links (one per client)
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/admin');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'testpass123');
    await page.click('button[type="submit"]');
    await expect(page.locator('#dashboard-view')).toBeVisible();

    // Create a unique family for this test run
    familyName = `E2E Family ${Date.now()}`;
    await page.click('text=+ New Family');
    await expect(page.locator('#create-family-modal')).toBeVisible();
    await page.fill('#family-name', familyName);
    await page.click('button:text("Create")');

    // Go to family detail
    await page.locator('.family-item', { hasText: familyName }).click();
    await expect(page.locator('#detail-view')).toBeVisible();

    // Create FIRST access link
    await page.click('text=+ Add Link');
    await expect(page.locator('#create-link-modal')).toBeVisible();
    await page.fill('#link-label', 'Test Client 1');
    await page.locator('#create-link-modal button:text("Create")').click();
    await expect(page.locator('#link-created-modal')).toBeVisible();
    accessLinkUrl = await page.locator('#created-link-url').inputValue();
    expect(accessLinkUrl).toContain('/t/');
    await page.click('button:text("Close")');

    await context.close();
  });

  test('client accesses app and logs events', async ({ page }) => {
    // Navigate to the access link
    const tokenPath = new URL(accessLinkUrl).pathname;
    await page.goto(tokenPath);

    // Should redirect to the main app
    await expect(page).toHaveURL(/\?family=/);

    // Should see the baby tracking UI with action buttons
    await expect(page.locator('.container')).toBeVisible();
    const buttons = page.locator('button.action');
    await expect(buttons.first()).toBeVisible();
    expect(await buttons.count()).toBeGreaterThan(3);

    // Log a feed event
    const feedButton = page.locator('button.action[data-type="feed"][data-value="bf"]');
    await expect(feedButton).toBeVisible();
    await feedButton.click();
    await expect(feedButton).toHaveClass(/fading/);
    await expect(page.locator('.event-entry', { hasText: 'feed' })).toBeVisible();
  });

  test('bidirectional sync: client -> server -> other session', async ({ browser }) => {
    // Open two browser contexts - simulating two different clients
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const tokenPath = new URL(accessLinkUrl).pathname;

    // Page1 accesses the app
    await page1.goto(tokenPath);
    await expect(page1).toHaveURL(/\?family=/);
    await expect(page1.locator('.container')).toBeVisible();

    // Page2 accesses the app
    await page2.goto(tokenPath);
    await expect(page2).toHaveURL(/\?family=/);
    await expect(page2.locator('.container')).toBeVisible();

    // Client 1 logs a unique event - use wet nappy
    const wetButton1 = page1.locator('button.action[data-type="nappy"][data-value="wet"]');
    await expect(wetButton1).toBeVisible();
    await wetButton1.click();

    // Client 2 logs a different unique event - use pram
    const pram = page2.locator('button.action[data-type="soothe"][data-value="pram"]');
    await expect(pram).toBeVisible();
    await pram.click();

    // Look for the event-type span containing "nappy" in the visible event entry
    await expect(page1.locator('.event-type:has-text("nappy")')).toBeVisible();

    // Client 2 should see the wet nappy event from client 1 via WebSocket
    await expect(page2.locator('.event-type:has-text("nappy")')).toBeVisible();

    // Also verify server persisted - open admin and check summary
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();

    await adminPage.goto('/admin');
    await adminPage.fill('#login-username', 'admin');
    await adminPage.fill('#login-password', 'testpass123');
    await adminPage.click('button[type="submit"]');
    await expect(adminPage.locator('#dashboard-view')).toBeVisible();

    await adminPage.locator('.family-item', { hasText: familyName }).click();
    await expect(adminPage.locator('#detail-view')).toBeVisible();

    // Summary should show the nappy event (wet = nappy type)
    await expect(adminPage.locator('#summary-totals')).toBeVisible();
    // The totals should contain nappy count
    await expect(adminPage.locator('#summary-totals', { hasText: 'nappy' })).toBeVisible();
  });

  test('second client offline and syncs on reconnect', async ({ browser }) => {
    // Open two browser contexts - simulating two different clients
    const context1 = await browser.newContext();

    const page1 = await context1.newPage();

    const tokenPath = new URL(accessLinkUrl).pathname;

    // Page1 accesses the app
    await page1.goto(tokenPath);
    await expect(page1).toHaveURL(/\?family=/);
    await expect(page1.locator('.container')).toBeVisible();
    const wetButton1 = page1.locator('button.action[data-type="nappy"][data-value="wet"]');
    await expect(wetButton1).toBeVisible()
    await wetButton1.click();

    // client 2 comes online
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto(tokenPath);
    await expect(page2).toHaveURL(/\?family=/);
    await expect(page2.locator('.container')).toBeVisible();

    // Client 2 should see the wet nappy event from client 1 via sync on reconnect
    await expect(page2.locator('.event-type:has-text("nappy")')).toBeVisible();
  });
});
