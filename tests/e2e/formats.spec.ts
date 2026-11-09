import {test,expect} from '@playwright/test';
import path from 'node:path';
test('all four formats render, search, bookmark and restore',async({page})=>{
  test.setTimeout(120000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'书架',exact:true}).click();await page.getByRole('button',{name:'导入书籍',exact:true}).first().click();
  await page.locator('input[type=file][accept*=".epub"]').setInputFiles([path.resolve('.cache/fixtures/山间阅读手记.epub'),path.resolve('.cache/fixtures/Granite Field Notes.pdf'),path.resolve('.cache/fixtures/Granite Field Notes.txt'),path.resolve('src/reader/__fixtures__/Around-the-World.mobi')]);
  await page.getByRole('button',{name:'导入 4 个文件',exact:true}).click();await expect(page.locator('.result-row').filter({hasText:'已导入'})).toHaveCount(4,{timeout:20000});
  const formats=['epub','pdf','txt','mobi'];
  for(let i=0;i<formats.length;i++){
    if(i){await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'书架',exact:true}).click();await page.getByRole('button',{name:'导入书籍',exact:true}).first().click();}
    await page.locator('.result-row').nth(i).getByRole('button',{name:'查看书籍'}).click();await page.getByRole('button',{name:/开始阅读|继续阅读/,exact:true}).click();
    await expect(page.locator('.reader-view')).toBeVisible();await expect(page.locator('.reader-loading')).toHaveCount(0,{timeout:25000});await expect(page.locator('.reader-error')).toHaveCount(0);
    if(formats[i]==='pdf')await expect(page.locator('.reader-pdf-page canvas').first()).toBeVisible();else await expect(page.locator('.reader-reflow')).toBeVisible();
    const bookmark=page.getByRole('button',{name:'在当前位置添加书签',exact:true});await bookmark.click();await expect(page.getByRole('button',{name:'删除当前位置书签',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'书内搜索',exact:true}).click();const query=formats[i]==='epub'?'山峰':formats[i]==='mobi'?'Fogg':'mountains';await page.getByRole('searchbox',{name:'搜索书内文字'}).fill(query);await page.getByRole('searchbox',{name:'搜索书内文字'}).press('Enter');await expect(page.locator('.reader-search__results button').first()).toBeVisible({timeout:15000});
    await page.keyboard.press('Escape');if(formats[i]==='pdf'){await page.getByRole('button',{name:'放大',exact:true}).click();await page.getByRole('button',{name:'顺时针旋转视图',exact:true}).click();await page.getByRole('button',{name:'适合宽度',exact:true}).click();}
    await page.screenshot({path:`artifacts/screenshots/format-${formats[i]}.png`,fullPage:true});
    await page.getByRole('button',{name:'退出阅读器',exact:true}).click();
  }
  expect(errors).toEqual([]);
});
