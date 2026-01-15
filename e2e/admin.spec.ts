import { test, expect } from '@playwright/test';

test.describe('Admin UI', () => {
  test('rejects invalid credentials', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('#login-view')).toBeVisible();

    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'wrongpassword');
    await page.click('button[type="submit"]');

    await expect(page.locator('#login-error')).toBeVisible();
    await expect(page.locator('#login-error')).toContainText('Invalid');
  });

  test('admin workflow: login, family CRUD, links, logout', async ({ page }) => {
    // Login
    await page.goto('/admin');
    await expect(page.locator('#login-view')).toBeVisible();
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'testpass123');
    await page.click('button[type="submit"]');
    await expect(page.locator('#dashboard-view')).toBeVisible();
    await expect(page.locator('header h1')).toContainText('Families');

    // Create family
    await page.click('text=+ New Family');
    await expect(page.locator('#create-family-modal')).toBeVisible();
    const familyName = `E2E Test ${Date.now()}`;
    await page.fill('#family-name', familyName);
    await page.fill('#family-notes', 'E2E test family');
    await page.click('button:text("Create")');
    await expect(page.locator('.family-item', { hasText: familyName })).toBeVisible();

    // View family detail
    await page.locator('.family-item', { hasText: familyName }).click();
    await expect(page.locator('#detail-view')).toBeVisible();
    await expect(page.locator('#detail-name')).toContainText(familyName);

    // Create access link
    await page.click('text=+ Add Link');
    await expect(page.locator('#create-link-modal')).toBeVisible();
    await page.fill('#link-label', 'Test Phone');
    await page.locator('#create-link-modal button:text("Create")').click();
    await expect(page.locator('#link-created-modal')).toBeVisible();
    const linkUrl = await page.locator('#created-link-url').inputValue();
    expect(linkUrl).toContain('/t/');
    await page.click('button:text("Close")');
    await expect(page.locator('.link-item')).toContainText('Test Phone');

    // Navigate summary dates
    const initialDate = await page.locator('#summary-date').textContent();
    await page.click('.date-nav button:first-child');
    const prevDate = await page.locator('#summary-date').textContent();
    expect(prevDate).not.toBe(initialDate);
    await page.click('.date-nav button:last-child');
    const restoredDate = await page.locator('#summary-date').textContent();
    expect(restoredDate).toBe(initialDate);

    // Back to dashboard
    await page.click('text=← Back to Families');
    await expect(page.locator('#dashboard-view')).toBeVisible();

    // Logout
    await page.click('button:text("Logout")');
    await expect(page.locator('#login-view')).toBeVisible();
  });
});
