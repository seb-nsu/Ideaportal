# Financial model V3 for Ideenportal (all values are assumptions/estimates)
# Reproduces the numbers in docs/release-0/business/finanzmodell.md (Version 3): python3 tools/finanzmodell.py
H = 60
FTE = 100000/12
MIX = {'Team':(0.20,590,100),'Business 1.000':(0.35,1490,250),'Business 2.500':(0.30,2490,450),'Enterprise':(0.15,3990,800)}
MRR_NEW = sum(s*p for s,p,_ in MIX.values())
IDEAS = sum(s*i for s,_,i in MIX.values())
KI_PER_IDEA = 1.45
INTRO_SHARE, INTRO_AVG, INTRO_COST = 0.80, 10000, 0.30
PARTNER_SHARE, PARTNER_RATE = 0.5, 0.20
PREPAY = 0.70
FACT = {'pess':0.5,'basis':1.0,'opt':1.5}

def base_rate(k):  # k = month relative to plan (market start = month 10)
    if k < 11: return 0
    if k <= 22: return 1.0
    if k <= 34: return 1.5
    if k <= 46: return 2.0
    return 2.5

def run(scen='basis', churn=0.15, ki_factor=1.0, variant='standard', shift=0, partner_rate=PARTNER_RATE, prepay=PREPAY):
    f = FACT[scen]; ms = 10+shift
    cohorts = []; rows = []; cum = cash = 0; acquired = 0
    for m in range(1, H+1):
        dp_active = 2 <= m <= ms-1
        dp_mrr = 3*250 if dp_active else 0
        if m == ms:
            cohorts.append(dict(start=m, n=2, mrr=1490, disc_until=m+11, dp=True, ideas=250))
        n_new = base_rate(m-shift)*f
        acquired += n_new
        if n_new: cohorts.append(dict(start=m, n=n_new, mrr=MRR_NEW, disc_until=0, dp=False, ideas=IDEAS))
        mrr = dp_mrr; cust = 0; cash_lic = dp_mrr; partner = 0; ideas = 0
        for c in cohorts:
            age = m-c['start']; alive = c['n']*(1-churn)**(age//12)
            price = c['mrr']*(0.5 if m <= c['disc_until'] else 1.0)
            mrr += alive*price; cust += alive; ideas += alive*c['ideas']/12
            if c['dp']: cash_lic += alive*price
            else:
                if age % 12 == 0: cash_lic += alive*prepay*price*12
                cash_lic += alive*(1-prepay)*price
                if age < 12: partner += alive*price*PARTNER_SHARE*partner_rate
        intro = n_new*INTRO_SHARE*INTRO_AVG
        chall = 0.5*f*2500 if m >= ms else 0
        revenue = mrr+intro+chall
        # team
        if variant == 'bootstrap':
            dev = 1 if acquired < 10 else (2 if acquired < 30 else 3)
            po = 0 if acquired < 5 else 1
            sales = 0 if acquired < 15 else (1 if acquired < 30 else 2)
            ux = 0.1 if m < ms else 0.2
        else:
            dev = 2 if acquired < 30 else 3
            po = 1
            sales = (1 if m >= ms-2 else 0) + (acquired >= 25) + (acquired >= 50)
            ux = 0.3 if m <= ms+1 else 0.2
        sup = 0.5*((cust>=8)+(cust>=20)+(cust>=40)+(cust>=60))
        fte = dev+po+ux+sales+sup; team = fte*FTE
        platform = 300+25*(cust+(3 if dp_active else 0))
        ki = (ideas + 300/12 + (3*150/12 if dp_active else 0))*KI_PER_IDEA*ki_factor
        cogs = platform+ki+0.01*revenue+intro*INTRO_COST
        other = 1500 if m < ms else 2500
        salesbud = 0 if m < ms-3 else (2000 if m < ms+2 else 3000)
        if variant == 'bootstrap': salesbud = 0 if m < ms-3 else 2000
        oneoff = {2:5000, 3+shift:8000, 6+shift:15000, ms-2:20000}.get(m, 0)
        if m >= ms+10 and (m-ms-10) % 12 == 0: oneoff += 15000
        cost = team+cogs+other+salesbud+partner+oneoff
        res = revenue-cost; cum += res
        cash += cash_lic+intro+chall-cost
        rows.append(dict(m=m, cust=cust, new=n_new, mrr=mrr, arr=mrr*12, revenue=revenue, intro=intro, chall=chall,
                         team=team, fte=fte, cogs=cogs, ki=ki, other=other, salesbud=salesbud, partner=partner, oneoff=oneoff,
                         sales_fte=sales, cost=cost, res=res, cum=cum, cash=cash))
    be = next((r['m'] for r in rows if r['m'] > ms and all(x['res'] + x['oneoff'] >= 0 for x in rows[r['m']-1:])), None)
    mincum = min(rows, key=lambda r: r['cum']); mincash = min(rows, key=lambda r: r['cash'])
    cumpos = next((r['m'] for r in rows if r['m'] > mincum['m'] and r['cum'] >= 0), None)
    return dict(rows=rows, be=be, mincum=mincum['cum'], mincum_m=mincum['m'], mincash=mincash['cash'], mincash_m=mincash['m'], cumpos=cumpos)

def cac(rows, a, b):
    sel = rows[a-1:b]
    spend = sum(r['sales_fte']*FTE+r['salesbud']+r['partner'] for r in sel)
    new = sum(r['new'] for r in sel)
    return spend, new, spend/new if new else None

def fm(x): return f"{x:,.0f}".replace(',', '.')

if __name__ == '__main__':
    print('MRR_NEW', MRR_NEW, 'ARPA', MRR_NEW*12, 'IDEAS', IDEAS, 'KI/yr', IDEAS*KI_PER_IDEA)
    for scen in ('pess','basis','opt'):
        for ch in (0.08,0.15):
            r = run(scen, ch); R = r['rows']
            print(f"{scen:5} {ch:.2f} cust12/24/36/60 {R[11]['cust']:.1f}/{R[23]['cust']:.1f}/{R[35]['cust']:.1f}/{R[59]['cust']:.1f} ARR {fm(R[11]['arr'])}/{fm(R[23]['arr'])}/{fm(R[35]['arr'])}/{fm(R[59]['arr'])} BE {r['be']} mincum {fm(r['mincum'])}@{r['mincum_m']} mincash {fm(r['mincash'])}@{r['mincash_m']} cumpos {r['cumpos']}")
    for k,kw in {'KIx3':dict(ki_factor=3),'prov15':dict(partner_rate=0.15),'noprepay':dict(prepay=0)}.items():
        r = run('basis',0.15,**kw); print(k, r['be'], fm(r['mincash']), r['mincash_m'], fm(r['mincum']))
    for ch in (0.08,0.15):
        r = run('basis',ch,variant='bootstrap',shift=6); R=r['rows']
        print('bootstrap',ch, r['be'], fm(r['mincash']), r['mincash_m'], fm(R[35]['arr']), fm(R[59]['arr']), r['cumpos'])
