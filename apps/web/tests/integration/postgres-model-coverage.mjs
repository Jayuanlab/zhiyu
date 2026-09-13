import {is} from 'drizzle-orm';
import {PgTable,getTableConfig} from 'drizzle-orm/pg-core';
import * as schema from '../../lib/db/schema.pg.ts';

/** Compare the actual migrated database against every exported PostgreSQL table. */
export async function inspectPostgresModelCoverage(client){
  const actual=await client`SELECT table_name,column_name,is_nullable,data_type,column_default
    FROM information_schema.columns WHERE table_schema='public'`;
  const tables=new Map();
  for(const row of actual){if(!tables.has(row.table_name))tables.set(row.table_name,new Map());tables.get(row.table_name).set(row.column_name,row);}
  const missingTables=[],missingColumns=[],nullabilityDifferences=[];
  let modelTables=0,modelColumns=0;
  const inspected=new Set();
  for(const value of Object.values(schema)){
    if(!is(value,PgTable))continue;
    const table=getTableConfig(value);
    if(inspected.has(table.name))continue;
    inspected.add(table.name);modelTables++;modelColumns+=table.columns.length;
    if(!tables.has(table.name)){missingTables.push(table.name);continue;}
    for(const column of table.columns){
      const found=tables.get(table.name).get(column.name);
      if(!found)missingColumns.push({table:table.name,column:column.name,type:column.getSQLType(),notNull:column.notNull});
      else if(column.notNull!==(found.is_nullable==='NO'))nullabilityDifferences.push({table:table.name,column:column.name,modelNotNull:column.notNull,databaseNullable:found.is_nullable});
    }
  }
  if(!modelTables)throw Error('No PostgreSQL models inspected');
  return {name:'PostgreSQL exported model table and column coverage',passed:missingTables.length===0&&missingColumns.length===0&&nullabilityDifferences.length===0,modelTables,modelColumns,missingTables,missingColumns,nullabilityDifferences};
}
