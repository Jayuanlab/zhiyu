import {and,asc,eq,gt} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import {chat} from '@/lib/db/schema';
import {getTaskSessionDir} from './sessions';
import {BoundedWorkspaceListing,ListingCursorError} from './bounded-listing';
import {resolveSessionListingPath} from './listing-boundary';

export const createWorkspaceListing=(resolveTaskPath=getTaskSessionDir)=>new BoundedWorkspaceListing({
  async nextRoot(owner,after,scope){
    if(scope){
      if(after)return null;
      const [row]=await db.select({id:chat.id}).from(chat).where(and(eq(chat.userId,owner),eq(chat.id,scope.taskId))).limit(1);
      if(!row)throw new ListingCursorError(403,'task_unavailable');
      const basePath=resolveTaskPath(row.id);
      return {taskId:row.id,basePath,path:scope.path?resolveSessionListingPath(basePath,scope.path):basePath};
    }
    const [row]=await db.select({id:chat.id}).from(chat)
      .where(and(eq(chat.userId,owner),after?gt(chat.id,after):undefined)).orderBy(asc(chat.id)).limit(1);
    return row?{taskId:row.id,path:resolveTaskPath(row.id)}:null;
  },
  async allowed(owner,taskId){
    const [row]=await db.select({id:chat.id}).from(chat).where(and(eq(chat.userId,owner),eq(chat.id,taskId))).limit(1);
    return Boolean(row);
  },
});
export const workspaceListing=createWorkspaceListing();
