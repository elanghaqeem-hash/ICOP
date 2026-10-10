import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { api, freshDb, login, makeApp, NEW_PW } from './helpers.js';
import { addBusinessMinutes, businessMinutesBetween, type Calendar } from '../src/lib/businessTime.js';
import { calendarFor, slaBreachCheck } from '../src/modules/helpdesk/routes.js';

let sql:Sql,app:FastifyInstance;
let admin:ReturnType<typeof api>,sales:ReturnType<typeof api>,pm:ReturnType<typeof api>,customer:ReturnType<typeof api>;
let tenantId='',customerId='',externalCustomer='',contractId='',ticketId='';
const previous=process.env.MFA_POLICY;

beforeAll(async()=>{
  process.env.MFA_POLICY='off';
  sql=await freshDb();app=await makeApp(sql);
  admin=api(app,await login(app,'companyadmin@defendit360.com'));
  sales=api(app,await login(app,'sales@defendit360.com'));
  pm=api(app,await login(app,'pm@defendit360.com'));
  const [t]=await sql`SELECT id FROM tenants WHERE code='DEIT'`;tenantId=String(t.id);
  const [u]=await sql`SELECT id FROM users WHERE tenant_id=${tenantId} AND email='companyadmin@defendit360.com'`;
  for(const [code,name] of [['SLA6A','PT Phase6 Managed SOC'],['SLA6B','PT Phase6 No Contract']] as const){
    const [c]=await sql`INSERT INTO customers(tenant_id,code,legal_name,industry,created_by)
      VALUES(${tenantId},${code},${name},'banking',${u.id}) RETURNING id`;
    if(code==='SLA6A')customerId=String(c.id);else externalCustomer=String(c.id);
  }
  const [contract]=await sql`INSERT INTO contracts
    (tenant_id,number,customer_id,contract_type,title,value,tax_rate,start_date,end_date,
     payment_terms,status,legal_checklist,created_by)
    VALUES(${tenantId},'C-SLA-P6',${customerId},'MANAGED_SERVICE','Managed SOC P6',5000000,11,
      current_date - 20,current_date + 90,'Bulanan','ACTIVE',${sql.json({})},${u.id}) RETURNING id`;
  contractId=String(contract.id);
  const hash=await bcrypt.hash(NEW_PW,12);
  await sql`INSERT INTO users(tenant_id,email,full_name,role,customer_id,password_hash,force_password_change)
    VALUES(${tenantId},'customer-phase6@example.invalid','Phase 6 Customer','customer_user',${customerId},${hash},false)`;
  const cLogin=await app.inject({method:'POST',url:'/api/v1/auth/login',
    payload:{email:'customer-phase6@example.invalid',password:NEW_PW}});
  if(cLogin.statusCode!==200)throw Error(cLogin.body);
  customer=api(app,cLogin.json().token);
},60000);
afterAll(async()=>{if(app)await app.close();if(sql)await sql.end();if(previous===undefined)delete process.env.MFA_POLICY;else process.env.MFA_POLICY=previous;});

describe('Phase6 Jakarta business SLA and contract-specific deadlines',()=>{
  const cal=(holidays:string[]=[]):Calendar=>({mode:'BUSINESS',startMin:480,endMin:1020,weekdays:[1,2,3,4,5],holidays:new Set(holidays)});
  const wib=(v:string)=>new Date(v+'+07:00');

  it('calculates working minutes over weekends and holidays',()=>{
    const friday=wib('2026-10-09T16:00:00');
    expect(addBusinessMinutes(friday,240,cal()).toISOString()).toBe(wib('2026-10-12T11:00:00').toISOString());
    expect(addBusinessMinutes(friday,240,cal(['2026-10-12'])).toISOString()).toBe(wib('2026-10-13T11:00:00').toISOString());
    expect(businessMinutesBetween(friday,wib('2026-10-13T11:00:00'),cal(['2026-10-12']))).toBe(240);
    expect(addBusinessMinutes(friday,60,{...cal(),mode:'24x7'}).toISOString()).toBe(wib('2026-10-09T17:00:00').toISOString());
  });

  it('allows only admin to change business calendar and holidays',async()=>{
    expect((await sales.put('/api/v1/helpdesk/calendar',
      {start:'08:00',end:'17:00',weekdays:[1,2,3,4,5]})).status).toBe(403);
    expect((await admin.put('/api/v1/helpdesk/calendar',
      {start:'17:00',end:'08:00',weekdays:[1,2,3,4,5]})).status).toBe(400);
    expect((await admin.put('/api/v1/helpdesk/calendar',
      {start:'08:30',end:'17:30',weekdays:[5,1,2,3,4]})).status).toBe(200);
    const sla=await pm.get('/api/v1/helpdesk/sla');
    expect(sla.body.businessHours).toMatchObject({start:'08:30',end:'17:30',
      weekdays:[1,2,3,4,5],timezone:'Asia/Jakarta'});
    expect(sla.body.items.find((x:any)=>x.priority==='P3').calendar).toBe('BUSINESS');
    expect((await sales.post('/api/v1/helpdesk/holidays',
      {day:'2026-12-24',name:'Cuti bersama'})).status).toBe(403);
    expect((await admin.post('/api/v1/helpdesk/holidays',
      {day:'2026-12-24',name:'Cuti bersama'})).status).toBe(201);
    expect((await admin.delete('/api/v1/helpdesk/holidays/2026-12-24')).status).toBe(200);
  });

  it('selects contract SLA when available and defaults to business calendar otherwise',async()=>{
    const items=[{priority:'P1',response:10,resolution:120,calendar:'24x7'}];
    expect((await pm.put(`/api/v1/contracts/${contractId}/sla`,{items})).status).toBe(403);
    expect((await sales.put(`/api/v1/contracts/${contractId}/sla`,{items})).status).toBe(200);
    const created=await pm.post('/api/v1/tickets',{
      customerId,category:'INCIDENT',priority:'P1',
      title:'Ransomware critical alert',description:'EDR detected file encryption'});
    expect(created.status).toBe(201);
    expect(created.body.slaSource).toBe('CONTRACT');
    expect(created.body.contractId).toBe(contractId);
    expect(Math.abs((new Date(created.body.resolutionDueAt).getTime() -
      new Date(created.body.createdAt).getTime())/60000-120)).toBeLessThan(1);
    ticketId=created.body.id;
    const def=await pm.post('/api/v1/tickets',{
      customerId:externalCustomer,category:'SERVICE_REQUEST',priority:'P3',
      title:'Business hours request',description:'Allowlist corporate subnet request'});
    expect(def.status).toBe(201);
    expect(def.body.slaSource).toBe('DEFAULT');
    expect(def.body.slaCalendar).toBe('BUSINESS');
    const c=await calendarFor(sql,tenantId,'BUSINESS');
    expect(Math.abs(businessMinutesBetween(new Date(def.body.createdAt),
      new Date(def.body.responseDueAt),c)-240)).toBeLessThan(1);
  });

  it('freezes resolution during WAITING_CUSTOMER and resumes when customer replies',async()=>{
    const waiting=await pm.patch(`/api/v1/tickets/${ticketId}`,{status:'WAITING_CUSTOMER'});
    expect(waiting.status).toBe(200);
    let ticket=(await pm.get(`/api/v1/tickets/${ticketId}`)).body.ticket;
    expect(ticket.paused).toBe(true);
    await sql`UPDATE tickets SET paused_at=now()-interval '90 minutes' WHERE id=${ticketId}`;
    const [old]=await sql`SELECT resolution_due_at FROM tickets WHERE id=${ticketId}`;
    await sql`UPDATE tickets SET resolution_due_at=now()-interval '1 minute' WHERE id=${ticketId}`;
    await slaBreachCheck(sql);
    const [row]=await sql`SELECT resolution_breached FROM tickets WHERE id=${ticketId}`;
    expect(row.resolutionBreached).toBe(false);
    await sql`UPDATE tickets SET resolution_due_at=${new Date(old.resolutionDueAt)} WHERE id=${ticketId}`;
    const response=await customer.post(`/api/v1/portal/tickets/${ticketId}/comments`,
      {body:'Sudah kami isolasi workstation terkait'});
    expect(response.status).toBe(201);
    const [updated]=await sql`SELECT paused_at,paused_minutes,resolution_due_at,status
      FROM tickets WHERE id=${ticketId}`;
    expect(updated.pausedAt).toBeNull();
    expect(updated.status).toBe('IN_PROGRESS');
    expect(Number(updated.pausedMinutes)).toBeGreaterThanOrEqual(89);
    expect(new Date(updated.resolutionDueAt).getTime()-new Date(old.resolutionDueAt).getTime())
      .toBeGreaterThanOrEqual(89*60000);
  });
});
