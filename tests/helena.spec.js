import {test,expect} from '@playwright/test';
test('configure HELENA template variables, reminder, recipient and mobile layout',async({page})=>{
 const channel='11111111-1111-4111-8111-111111111111',template='22222222-2222-4222-8222-222222222222';let saved;
 await page.route('**/api/workspaces/*/helena',route=>route.fulfill({json:{connected:true}}));
 await page.route('**/api/workspaces/*/helena/channels',route=>route.fulfill({json:[{id:channel,number:'5592999999999',name:'Canal oficial'}]}));
 await page.route('**/api/workspaces/*/helena/templates?*',route=>route.fulfill({json:[{id:template,name:'Lembrete aprovado',text:'Olá [p1], seu evento será às [p2].',params:[{name:'[p1]'},{name:'[p2]'}],fileType:'UNDEFINED'}]}));
 await page.route('**/api/workspaces/*/hooks',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().kind==='helena'){saved=route.request().postDataJSON();return route.fulfill({status:201,json:{...saved,id:'new'}});}return route.continue();});
 await page.goto('/');await page.getByLabel('E-mail',{exact:true}).fill('owner@folks.test');await page.getByLabel('Senha de acesso').fill('ui-test-password');await page.getByRole('button',{name:'Entrar na agenda'}).click();
 await page.getByRole('button',{name:'Automações',exact:true}).click();await page.getByRole('button',{name:'Nova regra de mensagem'}).click();
 await page.getByLabel('Nome da regra').fill('Aviso de 2 horas');await page.getByLabel('Modelo aprovado').selectOption(template);
 await page.getByLabel('Variável [p1]',{exact:true}).fill('{{nome}}');await page.getByLabel('Variável [p2]',{exact:true}).fill('{{hora}}');
 await page.getByLabel('Ao criar evento',{exact:true}).uncheck();await page.getByLabel('Antes do evento',{exact:true}).check();await page.getByLabel('Antecedência do lembrete').selectOption('120');
 await page.screenshot({path:'test-results/helena-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/helena-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Salvar regra',exact:true}).click();await expect(page.getByText('Regra salva.',{exact:true})).toBeVisible();expect(saved.reminderMinutes).toBe(120);expect(saved.parameters['[p1]']).toBe('{{nome}}');expect(saved.enabled).toBe(false);
 await page.getByRole('button',{name:'Agenda',exact:true}).click();await page.getByRole('button',{name:'Novo evento',exact:true}).click();await expect(page.getByLabel('WhatsApp do cliente')).toBeVisible();await expect(page.getByLabel('WhatsApp do responsável')).toBeVisible();
});
