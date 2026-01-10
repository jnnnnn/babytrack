import { test, expect } from '@playwright/test';

test.describe('Admin UI', () => {
  test('shows login page initially', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#login-view h1')).toContainText('Admin');
  });

  test('rejects invalid credentials', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'wrongpassword');
    await page.click('button[type="submit"]');
    await expect(page.locator('#login-error')).toBeVisible();
    await expect(page.locator('#login-error')).toContainText('Invalid');
  });

  test('logs in with valid credentials', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'testpass123');
    await page.click('button[type="submit"]');
    
    // Should show dashboard
    await expect(page.locator('#dashboard-view')).toBeVisible();
    await expect(page.locator('header h1')).toContainText('Families');
  });

  test('creates a new family', async ({ page }) => {
    // Login first
    await page.goto('/admin');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'testpass123');
    await page.click('button[type="submit"]');
    await expect(page.locator('#dashboard-view')).toBeVisible();

    // Create family
    await page.click('text=+ New Family');
    await expect(page.locator('#create-family-modal')).toBeVisible();
    
    await page.fill('#family-name', 'Test Baby');
    await page.fill('#family-notes', 'E2E test family');
    await page.click('button:text("Create")');

    // Should appear in list (use .first() in case multiple exist from previous runs)
    await expect(page.locator('.family-item').first()).toContainText('Test Baby');
  });

  test('views family detail', async ({ page }) => {
    // Login
    await page.goto('/admin');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'testpass123');
    await page.click('button[type="submit"]');
    await expect(page.locator('#dashboard-view')).toBeVisible();

    // Click on family (may be created by previous test or fresh)
    const familyItem = page.locator('.family-item').first();
    if (await familyItem.count() === 0) {
      // Create one if none exist
      await page.click('text=+ New Family');
      await page.fill('#family-name', 'Detail Test Baby');
      await page.click('button:text("Create")');
    }
    
    await page.locator('.family-item').first().click();
    await expect(page.locator('#detail-view')).toBeVisible();
    await expect(page.locator('#detail-name')).not.toBeEmpty();
  });

  test('creates access link', async ({ page }) => {
    // Login and navigate to family
    await page.goto('/admin');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'testpass123');
    await page.click('button[type="submit"]');
    await expect(page.locator('#dashboard-view')).toBeVisible();

    // Ensure family exists and go to detail
    const familyItem = page.locator('.family-item').first();
    if (await familyItem.count() === 0) {
      await page.click('text=+ New Family');
      await page.fill('#family-name', 'Link Test Baby');
      await page.click('button:text("Create")');
    }
    await page.locator('.family-item').first().click();
    await expect(page.locator('#detail-view')).toBeVisible();

    // Create link
    await page.click('text=+ Add Link');
    await expect(page.locator('#create-link-modal')).toBeVisible();
    
    await page.fill('#link-label', 'Test Phone');
    await page.locator('#create-link-modal button:text("Create")').click();

    // Should show created link modal
    await expect(page.locator('#link-created-modal')).toBeVisible();
    const linkUrl = await page.locator('#created-link-url').inputValue();
    expect(linkUrl).toContain('/t/');
    
    await page.click('button:text("Close")');
    
    // Link should appear in list
    await expect(page.locator('.link-item')).toContainText('Test Phone');
  });

  test('navigates summary dates', async ({ page }) => {
    // Login and navigate to family
    await page.goto('/admin');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'testpass123');
    await page.click('button[type="submit"]');
    await expect(page.locator('#dashboard-view')).toBeVisible();

    // Ensure family exists
    const familyItem = page.locator('.family-item').first();
    if (await familyItem.count() === 0) {
      await page.click('text=+ New Family');
      await page.fill('#family-name', 'Nav Test Baby');
      await page.click('button:text("Create")');
    }
    await page.locator('.family-item').first().click();
    await expect(page.locator('#detail-view')).toBeVisible();

    // Get initial date
    const initialDate = await page.locator('#summary-date').textContent();
    
    // Go back a day
    await page.click('.date-nav button:first-child');
    const prevDate = await page.locator('#summary-date').textContent();
    expect(prevDate).not.toBe(initialDate);
    
    // Go forward
    await page.click('.date-nav button:last-child');
    const restoredDate = await page.locator('#summary-date').textContent();
    expect(restoredDate).toBe(initialDate);
  });

  test('logs out', async ({ page }) => {
    // Login
    await page.goto('/admin');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'testpass123');
    await page.click('button[type="submit"]');
    await expect(page.locator('#dashboard-view')).toBeVisible();

    // Logout
    await page.click('button:text("Logout")');
    await expect(page.locator('#login-view')).toBeVisible();
  });
});
