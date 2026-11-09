// Source connection is SELECT/SHOW only. Destructive statements are restricted
// to the confirmed fingerprint destination after verified backups and rehearsal.
import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { exportBiometricBackup } from './lib/biometric-readonly-export.mjs';
import { restoreBiometricBackup, verifyBiometricBackup } from './lib/biometric-restore.mjs';
import { BACKUP_TABLES, MIGRATION_TABLES, canonicalRowsHash, deserializeRow } from './lib/biometric-backup-format.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const verification=path.join(root,'verification');
const latestPath=path.join(verification,'biometric-migration-latest.json');
const stagePattern=/^biometric_portal_restore_[a-f0-9]{12}$/;
const audit=[];
const sessions=new Set();
const safeCode=error=>/^[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:'BIOMETRIC_MIGRATION_FAILED';
const fail=code=>Object.assign(new Error('Biometric migration operation could not be completed'),{code});
const sha=text=>createHash('sha256').update(text).digest('hex');
const quote=name=>{if(!/^[A-Za-z0-9_]+$/.test(name))throw fail('MIGRATION_IDENTIFIER_REJECTED');return '`'+name+'`';};
function scopeSchema(schema){if(schema!=='fingerprint'&&!stagePattern.test(schema))throw fail('MIGRATION_WRITE_SCHEMA_REJECTED');}

function environment(){
  const source={host:process.env.TIDB_SOURCE_HOST,port:Number(process.env.TIDB_SOURCE_PORT),user:process.env.TIDB_SOURCE_USER,password:process.env.TIDB_SOURCE_PASSWORD,database:process.env.TIDB_SOURCE_DATABASE};
  const admin={host:process.env.TIDB_SETUP_HOST,port:Number(process.env.TIDB_SETUP_PORT),user:process.env.TIDB_SETUP_USER,password:process.env.TIDB_SETUP_PASSWORD,database:process.env.TIDB_SETUP_DATABASE};
  const reader={host:process.env.BIOMETRIC_TEST_DB_HOST,port:Number(process.env.BIOMETRIC_TEST_DB_PORT),user:process.env.BIOMETRIC_TEST_DB_USER,password:process.env.BIOMETRIC_TEST_DB_PASSWORD,database:process.env.BIOMETRIC_TEST_DB_NAME};
  if(source.database!=='test'||admin.database!=='fingerprint'||reader.database!=='fingerprint'||!source.user||source.user.endsWith('.root')||
      admin.host!==reader.host||admin.port!==reader.port||!admin.user?.endsWith('.root')||admin.user.split('.')[0]!==reader.user?.split('.')[0])throw fail('MIGRATION_ENDPOINTS_REJECTED');
  for(const config of [source,admin,reader])if(!config.host||!Number.isSafeInteger(config.port)||config.port<1||config.port>65535||!config.user||!config.password)throw fail('MIGRATION_CONFIG_INVALID');
  return {source,admin,reader};
}

async function open(config,{side,write=false,control=false}={}){
  if(write&&!control)scopeSchema(config.database);
  const raw=await mysql.createConnection({...config,database:control?undefined:config.database,connectTimeout:6000,
    dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,jsonStrings:true,multipleStatements:false,flags:'-LOCAL_FILES',
    ssl:{minVersion:'TLSv1.2',rejectUnauthorized:true,verifyIdentity:true}});
  raw.on('error',()=>{});
  const context={raw,side,schema:control?null:config.database,write,control};sessions.add(context);
  async function run(method,input,params=[]){
    const sql=typeof input==='string'?input:input?.sql;
    if(typeof sql!=='string'||!Array.isArray(params)||sql.includes('\0'))throw fail('MIGRATION_SQL_INVALID');
    const select=/^\s*SELECT\b/i.test(sql)&&!/[;]|--|#|\/\*|:=/.test(sql)&&!(/\bINTO\b|\bFOR\s+(?:UPDATE|SHARE)\b|\b(?:LOAD_FILE|GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK)\s*\(/i.test(sql));
    const show=/^SHOW CREATE TABLE `(?:test|fingerprint|biometric_portal_restore_[a-f0-9]{12})`\.`biometric_(?:svc_[a-z_]+|portal_test_identity)`$/i.test(sql);
    if(!write&&!select&&!show)throw fail('MIGRATION_SOURCE_NON_READ_REJECTED');
    if(write&&!select&&!show){
      if(/(?:`test`|\btest)\s*\./i.test(sql))throw fail('MIGRATION_SOURCE_WRITE_REJECTED');
      if(control){
        const match=/^(CREATE|DROP) DATABASE `(fingerprint|biometric_portal_restore_[a-f0-9]{12})`(?: CHARACTER SET utf8mb4 COLLATE utf8mb4_bin)?$/.exec(sql);
        if(!match)throw fail('MIGRATION_CONTROL_SQL_REJECTED');
      }else{
        scopeSchema(context.schema);
        if(!/^(?:CREATE TABLE|INSERT INTO)\b/i.test(sql))throw fail('MIGRATION_DESTINATION_SQL_REJECTED');
      }
    }
    const entry={side,schema:context.schema,kind:sql.trim().split(/\s+/)[0].toUpperCase(),sql,startedAtUtc:new Date().toISOString()};audit.push(entry);
    try{const result=await raw[method]({sql,timeout:10000},params);entry.status='ok';return result;}
    catch(error){entry.status='failed';entry.code=safeCode(error);throw fail(entry.code);}
    finally{entry.completedAtUtc=new Date().toISOString();}
  }
  const connection={execute:(sql,params=[])=>run('execute',sql,params),query:(sql,params=[])=>run('query',sql,params),
    async end(){if(!sessions.has(context))return;try{await raw.end();}finally{sessions.delete(context);}}};
  try{
    const [rows]=await connection.execute('SELECT DATABASE() AS current_database');
    if((rows[0]?.current_database??null)!==context.schema)throw fail('MIGRATION_SELECTED_SCHEMA_MISMATCH');
  }catch(error){await connection.end().catch(()=>raw.destroy());throw error;}
  return connection;
}

function localFile(directory,name){
  const resolved=path.resolve(directory,name);
  if(!resolved.startsWith(path.resolve(directory)+path.sep)||!/^biometric_(?:svc_[a-z_]+|portal_test_identity)\.rows\.json$/.test(name))throw fail('MIGRATION_BACKUP_PATH_REJECTED');
  return resolved;
}
async function writeJson(file,value,exclusive=false){await fs.writeFile(file,JSON.stringify(value,null,2),{flag:exclusive?'wx':'w',mode:0o600});}
async function save(record){record.updatedAtUtc=new Date().toISOString();await writeJson(latestPath,record);}
async function loadBundle(entry){
  const directory=path.resolve(root,entry.directory);
  if(!directory.startsWith(verification+path.sep))throw fail('MIGRATION_BUNDLE_PATH_REJECTED');
  const text=await fs.readFile(path.join(directory,'manifest.json'),'utf8');
  if(sha(text)!==entry.manifestSha256)throw fail('MIGRATION_MANIFEST_HASH_MISMATCH');
  const manifest=JSON.parse(text);
  const expected=manifest.purpose==='source'?MIGRATION_TABLES:BACKUP_TABLES;
  if(manifest.format!=='biometric-backup-v1'||!manifest.consistentSnapshot||manifest.tables.length!==expected.length||
      new Set(manifest.tables.map(table=>table.name)).size!==expected.length||manifest.tables.some(table=>!expected.includes(table.name)))throw fail('MIGRATION_MANIFEST_REJECTED');
  const readRowsFile=async name=>JSON.parse(await fs.readFile(localFile(directory,name),'utf8'));
  for(const table of manifest.tables){
    const encoded=await readRowsFile(table.rowsFile);
    const rows=encoded.map(row=>{const values=deserializeRow(row);return Object.fromEntries(table.columns.map((column,index)=>[column,values[index]]));});
    if(rows.length!==table.rowCount||canonicalRowsHash(table.columns,rows)!==table.rowsSha256)throw fail('MIGRATION_BACKUP_HASH_MISMATCH');
  }
  return {manifest,readRowsFile};
}

async function backupOnly(config){
  await fs.mkdir(verification,{recursive:true});
  try{
    await fs.access(latestPath);
    throw fail('MIGRATION_RUN_ALREADY_EXISTS');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const directory=await fs.mkdtemp(path.join(verification,'biometric-migration-2026-11-09-'));
  const record={format:'biometric-migration-record-v1',phase:'backing-up',startedAtUtc:new Date().toISOString(),
    directory:path.relative(root,directory).replaceAll('\\','/'),sourceWritesAttempted:0,temporarySchemas:[],targetRebuilt:false};
  await save(record);
  for(const purpose of ['destination','source']){
    const backupDir=path.join(directory,purpose);await fs.mkdir(backupDir);
    const connection=await open(purpose==='source'?config.source:config.reader,{side:purpose});
    try{
      const manifest=await exportBiometricBackup({connection,schema:purpose==='source'?'test':'fingerprint',purpose,
        writeRowsFile:async(name,rows)=>writeJson(localFile(backupDir,name),rows,true)});
      const manifestText=JSON.stringify(manifest,null,2);await fs.writeFile(path.join(backupDir,'manifest.json'),manifestText,{flag:'wx',mode:0o600});
      record[purpose]={directory:path.relative(root,backupDir).replaceAll('\\','/'),manifestSha256:sha(manifestText),snapshotAt:manifest.snapshotAt,
        counts:Object.fromEntries(manifest.tables.map(table=>[table.name,table.rowCount]))};
      await loadBundle(record[purpose]);await save(record);
      console.log(`[biometric-migration] ${purpose} backup saved and file hashes verified`);
    }finally{await connection.end();}
  }
  record.phase='backups-saved';await save(record);return record;
}

async function inspectDatabaseTables(connection,schema){
  const [rows]=await connection.execute('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',[schema]);
  return rows;
}
async function createSchema(control,schema){scopeSchema(schema);await control.query('CREATE DATABASE '+quote(schema)+' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');}
async function dropOwnedSchema(control,schema,record){
  if(!stagePattern.test(schema)||!record.temporarySchemas.some(item=>item.name===schema&&item.created))throw fail('MIGRATION_TEMP_DROP_REJECTED');
  await control.query('DROP DATABASE '+quote(schema));
  record.temporarySchemas.find(item=>item.name===schema).removed=true;
}

async function verifyBackups(config,record){
  if(record.phase!=='backups-saved')throw fail('MIGRATION_BACKUP_PHASE_REQUIRED');
  const control=await open(config.admin,{side:'target-control',write:true,control:true});
  try{
    for(const purpose of ['destination','source']){
      const bundle=await loadBundle(record[purpose]);
      const schema='biometric_portal_restore_'+randomBytes(6).toString('hex');
      const item={name:schema,purpose,created:false,removed:false};record.temporarySchemas.push(item);await save(record);
      await createSchema(control,schema);item.created=true;await save(record);
      const connection=await open({...config.admin,database:schema},{side:'rehearsal-'+purpose,write:true});
      try{
        const validation=await restoreBiometricBackup({connection,schema,...bundle});
        if(!validation.passed)throw fail('MIGRATION_REHEARSAL_MISMATCH');
        item.verified=true;item.validation=validation;await save(record);
      }finally{await connection.end();}
      await dropOwnedSchema(control,schema,record);await save(record);
      console.log(`[biometric-migration] ${purpose} backup restored and compared in an isolated schema`);
    }
    record.phase='backups-verified';await save(record);return record;
  }finally{await control.end();}
}

async function rebuildTarget(config,record){
  if(record.phase!=='backups-verified'||record.targetRebuilt||record.temporarySchemas.length!==2||record.temporarySchemas.some(item=>!item.verified||!item.removed))throw fail('MIGRATION_REBUILD_GATE_REJECTED');
  const source=await loadBundle(record.source),destination=await loadBundle(record.destination);
  if(source.manifest.purpose!=='source'||source.manifest.schema!=='test'||destination.manifest.schema!=='fingerprint')throw fail('MIGRATION_BACKUP_IDENTITY_REJECTED');
  const before=await open(config.reader,{side:'target-pre-delete-check'});
  try{
    const current=await inspectDatabaseTables(before,'fingerprint');
    if(current.length!==BACKUP_TABLES.length||current.some(row=>!BACKUP_TABLES.includes(row.TABLE_NAME)||row.TABLE_TYPE!=='BASE TABLE'))throw fail('MIGRATION_TARGET_TABLES_CHANGED');
    const check=await verifyBiometricBackup({connection:before,schema:'fingerprint',...destination});
    if(!check.passed)throw fail('MIGRATION_TARGET_CHANGED_SINCE_BACKUP');
    record.beforeDeleteVerified=true;record.beforeDeleteVerification=check;await save(record);
  }finally{await before.end();}
  const control=await open(config.admin,{side:'target-control',write:true,control:true});
  let dropAttempted=false;
  try{
    record.phase='rebuilding-target';record.dropAuthorizedTarget='fingerprint';await save(record);
    dropAttempted=true;record.targetDropAttempted=true;
    await control.query('DROP DATABASE `fingerprint`');record.targetDropped=true;await save(record);
    await createSchema(control,'fingerprint');record.targetRecreated=true;await save(record);
    const connection=await open(config.admin,{side:'target-restore',write:true});
    try{
      const result=await restoreBiometricBackup({connection,schema:'fingerprint',...source});
      if(!result.passed)throw fail('MIGRATION_TARGET_RESTORE_MISMATCH');
      const tables=await inspectDatabaseTables(connection,'fingerprint');
      if(tables.length!==MIGRATION_TABLES.length||tables.some(row=>!MIGRATION_TABLES.includes(row.TABLE_NAME)))throw fail('MIGRATION_FINAL_TABLES_INVALID');
      record.finalValidation=result;
    }finally{await connection.end();}
    const reader=await open(config.reader,{side:'target-reader-post-copy'});
    try{
      const check=await verifyBiometricBackup({connection:reader,schema:'fingerprint',...source});
      if(!check.passed)throw fail('MIGRATION_READER_VERIFICATION_FAILED');
      record.readerValidation=check;
    }finally{await reader.end();}
    record.targetRebuilt=true;record.phase='complete';record.completedAtUtc=new Date().toISOString();
    record.sourceSnapshotAt=source.manifest.snapshotAt;record.copiesRowsAfterSnapshot=false;
    record.portalTestIdentityPresent=false;record.deviceAndRailwayChanged=false;await save(record);
    return record;
  }catch(error){
    record.rebuildFailure={code:safeCode(error)};
    if(dropAttempted){
      record.rollback={attempted:true,passed:false};
      // A failed journal write must never prevent recovery of a dropped schema.
      await save(record).catch(()=>{record.journalWriteFailed=true;});
      let recoveryControl;
      try{
        // DROP may have succeeded before a timeout. Check with a fresh session.
        recoveryControl=await open(config.admin,{side:'target-recovery-control',write:true,control:true});
        const [exists]=await recoveryControl.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',['fingerprint']);
        let originalStillIntact=false;
        if(exists.length){
          const checkConnection=await open(config.admin,{side:'target-recovery-read'});
          try{originalStillIntact=(await verifyBiometricBackup({connection:checkConnection,schema:'fingerprint',...destination})).passed;}
          catch(checkError){
            if(checkError.code!=='BIOMETRIC_RESTORE_TABLE_SET_MISMATCH')throw checkError;
          }finally{await checkConnection.end();}
        }
        if(originalStillIntact){record.rollback.originalAlreadyIntact=true;record.rollback.passed=true;}
        else{
          if(exists.length)await recoveryControl.query('DROP DATABASE `fingerprint`');
          await createSchema(recoveryControl,'fingerprint');
          const connection=await open(config.admin,{side:'target-rollback',write:true});
          try{const check=await restoreBiometricBackup({connection,schema:'fingerprint',...destination});if(!check.passed)throw fail('MIGRATION_ROLLBACK_MISMATCH');record.rollback.passed=true;}
          finally{await connection.end();}
        }
        record.phase='rolled-back';
      }catch(rollbackError){record.rollback.code=safeCode(rollbackError);record.phase='rollback-needs-attention';}
      finally{await recoveryControl?.end().catch(()=>{});}
      await save(record).catch(()=>{record.journalWriteFailed=true;});
    }
    throw error;
  }finally{await control.end();}
}

async function main(){
  const mode=process.argv[2]??'--backup-only';
  if(process.argv.length>3||!['--backup-only','--verify-backups','--rebuild-target'].includes(mode))throw fail('MIGRATION_ARGUMENTS_INVALID');
  const config=environment();let record;
  if(mode==='--backup-only')record=await backupOnly(config);
  else{
    record=JSON.parse(await fs.readFile(latestPath,'utf8'));
    if(record.format!=='biometric-migration-record-v1')throw fail('MIGRATION_RECORD_INVALID');
    record=mode==='--verify-backups'?await verifyBackups(config,record):await rebuildTarget(config,record);
  }
  console.log(JSON.stringify({phase:record.phase,sourceSnapshotAt:record.source?.snapshotAt,sourceCounts:record.source?.counts,
    destinationBackupSaved:Boolean(record.destination),sourceBackupSaved:Boolean(record.source),targetRebuilt:record.targetRebuilt,
    sourceWritesAttempted:0,rollback:record.rollback??null}));
}

try{await main();}
catch(error){console.error(JSON.stringify({code:safeCode(error),sourceWritesAttempted:0}));process.exitCode=1;}
finally{
  for(const session of [...sessions]){try{await session.raw.end();}catch{session.raw.destroy();}sessions.delete(session);}
  const sourceStatements=audit.filter(entry=>entry.side==='source');
  const auditRecord={completedAtUtc:new Date().toISOString(),sourceWritesAttempted:0,
    sourceCommandKinds:[...new Set(sourceStatements.map(entry=>entry.kind))],statements:audit};
  await fs.mkdir(verification,{recursive:true});
  await writeJson(path.join(verification,'biometric-migration-audit-'+Date.now()+'.json'),auditRecord);
}
