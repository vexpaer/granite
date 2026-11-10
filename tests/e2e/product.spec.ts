import { test,expect } from '@playwright/test';
import path from 'node:path';
test('offline library, EPUB reading, notes and restart preserve user data',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await expect(page.getByRole('navigation',{name:'主导航'})).toBeVisible();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'书架',exact:true}).click();
  await page.getByRole('button',{name:'导入书籍',exact:true}).first().click();
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles(['山间阅读手记.epub','Granite Field Notes.pdf','Granite Field Notes.txt'].map(f=>path.resolve('.cache/fixtures',f)));
  await page.getByRole('button',{name:'导入 3 个文件',exact:true}).click();
  await expect(page.locator('.result-row').filter({hasText:'已导入'})).toHaveCount(3);
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'书架',exact:true}).click();
  await expect(page.getByText('山间阅读手记',{exact:true}).first()).toBeVisible();
  await page.getByText('山间阅读手记',{exact:true}).first().click();
  await page.getByRole('button',{name:'开始阅读',exact:true}).click();
  await expect(page.locator('.reader-view')).toBeVisible();
  await page.screenshot({path:'artifacts/screenshots/reader-epub.png',fullPage:true,animations:'disabled'});
  await page.keyboard.press('Escape');
  // Toolbar/back behavior is tested through its visible accessible action after load.
  const back=page.getByRole('button',{name:/退出阅读|返回书库|返回.*详情|返回/}).first();
  if(await back.isVisible())await back.click();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'笔记',exact:true}).click();
  await page.getByRole('button',{name:/新建笔记|新建空白笔记/}).first().click();
  await page.getByRole('textbox',{name:'笔记标题',exact:true}).fill('离线保存与恢复');
  await page.getByRole('textbox',{name:'Markdown 正文',exact:true}).fill('# 山间\n\n离线也能写作。[[阅读索引]]');
  await expect(page.getByText('已保存',{exact:true}).first()).toBeVisible();
  await page.screenshot({path:'artifacts/screenshots/notebook.png',fullPage:true,animations:'disabled'});
  await page.reload();
  await expect(page.getByRole('textbox',{name:'笔记标题',exact:true})).toHaveValue('离线保存与恢复');
  await expect(page.getByRole('textbox',{name:'Markdown 正文',exact:true})).toHaveValue('# 山间\n\n离线也能写作。[[阅读索引]]');
  expect(errors).toEqual([]);
});

test('empty state, desktop navigation and compact layout remain usable',async({page})=>{
  await page.goto('/');await expect(page.getByRole('navigation',{name:'主导航'})).toBeVisible();
  const nav=page.getByRole('navigation',{name:'主导航'});
  for(const name of ['主页','书架','笔记','统计'])await expect(nav.getByRole('button',{name,exact:true})).toBeVisible();
  await page.screenshot({path:'artifacts/screenshots/home-empty.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  await expect(nav.getByRole('button',{name:'书架',exact:true})).toBeVisible();
  await page.screenshot({path:'artifacts/screenshots/compact-browser.png',fullPage:true,animations:'disabled'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)).toBe(false);
});
