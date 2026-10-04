import { expect, type Locator, type Page } from '@playwright/test';

// The sidebar holds the conversation list, its row actions and the device switcher. Up to 760 px wide (style.css)
// it is a drawer behind Open navigation; wider layouts show it beside the page. Helpers open it as a person would.
const drawerWidth = 760;
export async function openSidebar(page: Page): Promise<Locator> {
  const sidebar = page.getByRole('complementary', { name: 'Conversations', exact: true });
  if (page.viewportSize()!.width <= drawerWidth) {
    const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  await expect(sidebar).toBeInViewport();
  return sidebar;
}

/** Opens the device switcher in the sidebar; the caller picks the device. */
export async function openDeviceSwitcher(page: Page): Promise<Locator> {
  await openSidebar(page);
  const switcher = page.locator('.device-switcher');
  await switcher.locator('summary').click();
  return switcher;
}

/**
 * The selected conversation's settings (next step, model, effort and settling its work) open from the
 * gear in its sidebar row actions, in a side panel.
 */
export async function openConversationSettings(page: Page): Promise<Locator> {
  const sidebar = await openSidebar(page);
  const entry = sidebar.locator('.conversation-list-entry').filter({ has: page.locator('.conversation-row.selected') });
  const actions = entry.getByRole('button', { name: /^Actions for / });
  if ((await actions.getAttribute('aria-expanded')) !== 'true') await actions.click();
  await entry.getByRole('group', { name: /^Actions for / }).getByRole('button', { name: 'Settings', exact: true }).click();
  const panel = conversationSettings(page);
  await expect(panel).toBeVisible();
  return panel;
}

export function conversationSettings(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Conversation settings', exact: true });
}

export async function closeConversationSettings(page: Page): Promise<void> {
  const panel = conversationSettings(page);
  await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(panel).toHaveCount(0);
}

/** The confirmation that closes, settles or discards a conversation's work. */
export function settlement(page: Page): Locator {
  return page.getByRole('dialog', { name: /^(Close|Discard) this work$/ });
}
