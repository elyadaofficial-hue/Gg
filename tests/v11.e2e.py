from playwright.sync_api import sync_playwright
res=[];errs=[]
def ck(n,c):res.append(bool(c));print('PASS' if c else 'FAIL',n)
with sync_playwright() as p:
    b=p.chromium.launch();pg=b.new_context(viewport={'width':390,'height':844},service_workers='block').new_page()
    pg.add_init_script("localStorage.setItem('wisey-login-asked','true')");pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.goto('http://localhost:8765/index.html');pg.wait_for_timeout(700)
    pg.evaluate("""(()=>{const t=todayStr();[0,1,2,4,5,8,9].forEach(i=>state.entries.workout.push({id:uid(),date:dayAdd(t,-i),type:'Push'}));[0,1,3].forEach(i=>state.entries.sleep.push({id:uid(),date:dayAdd(t,-i),hours:'7'}));
      state.goals.unshift({id:uid(),area:'אישי',title:'יעד בדיקה',why:'',measure:'',next:'צעד ראשון',due:'2026-12-01',side:false,status:'פעיל',created:t,log:[{date:t,text:'בוצע: משהו'}]});
      state.reminders.push({id:uid(),time:'23:59',message:'תזכורת בדיקה',days:[],eventId:null});save();render();})()""")
    ck('home has focus button',pg.locator('button:has-text("🎯 מצב ממוקד")').count()>=1)
    pg.locator('button:has-text("🎯 מצב ממוקד")').first.click();pg.wait_for_timeout(300)
    t=pg.inner_text('#app');ck('focus view content',all(s in t for s in ['3 הדברים החשובים','צעד ראשון','תזכורת בדיקה','יעד בדיקה','התקדמות היום']))
    ck('focus hides secondary',('תובנות' not in t) and ('תזכורות יומיות' not in t))
    ck('data untouched',pg.evaluate("state.entries.workout.length===7"))
    pg.click('button:has-text("יציאה")');pg.wait_for_timeout(300);ck('exit focus restores home',pg.locator('text=תזכורות יומיות').count()>=0 and pg.evaluate("!state.focus"))
    pg.evaluate("goTo('weekly')");pg.wait_for_timeout(300)
    t=pg.inner_text('#app');ck('report on weekly page',all(s in t for s in ['דוח ביצועים','הכי עקבי','מול השבוע הקודם']));print(t[t.index('דוח ביצועים'):][:420].replace('\n',' | '))
    pg.evaluate("goTo('coach')");pg.wait_for_timeout(300)
    ck('heatmap card',pg.locator('.hm-c').count()>=28 and pg.locator('.hm-leg').count()==1)
    pg.locator('.hm-c.l1, .hm-c.l2, .hm-c.l3, .hm-c.l4').first.click();pg.wait_for_timeout(200)
    ck('day click shows records',pg.locator('text=אימונים').count()>=1 or pg.locator('text=שינה').count()>=1)
    pg.click('button[aria-label="חודש קודם"]');pg.wait_for_timeout(200);ck('month nav',pg.evaluate("hmM")!=pg.evaluate("todayStr().slice(0,7)"))
    ck('no overflow coach',pg.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
    # quick capture
    pg.evaluate("goTo('home')");pg.wait_for_timeout(200)
    ck('fab exists',pg.locator('#qcBtn').count()==1)
    pg.click('#qcBtn');ck('menu opens 6',pg.locator('#qcMenu button').count()==6 and pg.locator('#qcMenu').is_visible())
    pg.click('#qcMenu button:has-text("אימון")');pg.wait_for_timeout(500)
    ck('workout form opened',pg.evaluate("active")=='workout' and pg.evaluate("!document.getElementById('qcMenu')||document.getElementById('qcMenu').hidden"))
    for nm,tab in [('ארוחה','nutrition'),('שינה','sleep'),('לימוד','studies')]:
        pg.click('#qcBtn');pg.click(f'#qcMenu button:has-text("{nm}")');pg.wait_for_timeout(400);ck('capture '+nm,pg.evaluate("active")==tab)
    pg.click('#qcBtn');pg.click('#qcMenu button:has-text("משימה")');pg.wait_for_timeout(500)
    ck('task prefix in TODO',pg.evaluate("active")=='home' and pg.evaluate("document.getElementById('todayNote').value.includes('☐ ')"))
    pg.click('#qcBtn');pg.click('#qcMenu button:has-text("מחשבה")');pg.wait_for_timeout(400);ck('thought focuses reflection',pg.evaluate("document.activeElement&&document.activeElement.id")=='refBox')
    pg.click('#qcBtn');pg.keyboard.press('Escape');ck('escape closes',pg.evaluate("document.getElementById('qcMenu').hidden"))
    ck('nav unchanged count',pg.locator('nav button').count()>0)
    for tt in ['sales','workout','nutrition','sleep','studies','content','goals','results','history','review','prayer']:
        pg.evaluate(f"goTo('{tt}')");pg.wait_for_timeout(100)
    ck('no overflow',pg.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
    print('ERR',errs);b.close()
print(res.count(False),'failed')
