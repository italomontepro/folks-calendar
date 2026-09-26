import { test, expect } from '@playwright/test';

test('relatório abre com login, dados reais agregados e filtros de equipe', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('E-mail').fill('owner@folks.test');
  await page.getByLabel('Senha de acesso').fill('ui-test-password');
  await page.getByRole('button', { name: /Entrar na agenda/ }).click();
  await expect(page.getByRole('button', { name: /Relatório/ })).toBeVisible();
  await page.route('**/api/workspaces/*/report?month=*', route => route.fulfill({ json: {
    month: '2026-09', updatedAt: '2026-09-23T12:00:00Z', previousTotal: 1,
    departments: [{ id: 'sales', name: 'Comercial' }, { id: 'support', name: 'Suporte' }],
    agents: [{ id: 'ana', name: 'Ana', departments: ['sales'] }, { id: 'bia', name: 'Bia', departments: ['support'] }],
    panels: [{ id: 'panel', name: 'Vendas', steps: [{ id: 'lead', name: 'Lead' }] }],
    cardsByPanel: { panel: [{ id: 'card', status: 'WON', amount: 250, userId: 'ana', sessionId: 's1', stepId: 'lead' }] },
    sessions: [
      { id: 's1', createdAt: '2026-09-01T12:00:00Z', status: 'COMPLETED', departmentId: 'sales', userId: 'ana', channel: 'INSTAGRAM', waitSeconds: 120, serviceSeconds: 300, firstSeconds: 120 },
      { id: 's2', createdAt: '2026-09-02T12:00:00Z', status: 'PENDING', departmentId: 'support', userId: 'bia', channel: 'CLOUDAPI_WHATSAPP', waitSeconds: null, serviceSeconds: null, firstSeconds: null }
    ]
  } }));
  await page.getByRole('button', { name: /Relatório/ }).click();
  await expect(page.getByRole('heading', { name: 'Relatório de Atendimento e Vendas' })).toBeVisible();
  await expect(page.locator('.report-hero strong')).toHaveText('2');
  await page.getByRole('button', { name: 'Equipes', exact: true }).click();
  await page.getByRole('button', { name: 'Comercial', exact: true }).click();
  await expect(page.locator('.report-hero strong')).toHaveText('1');
  await expect(page.getByText('R$ 250', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/report-desktop.png', fullPage: true });
});
