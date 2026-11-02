import type {ImageAttachment} from '../types';
import type {ImageContent} from '@earendil-works/pi-ai';
/** Images are explicit host inputs. Fetching an arbitrary model-supplied URL
 * or treating a host pathname as an image source is never implicit. */
export function preparePiImages(images:ImageAttachment[]|undefined):ImageContent[]{
  if(!images)return [];
  if(images.length>10)throw Error('pi_image_limit');
  return images.map(image=>{
    const data=image.data?.replace(/^data:image\/[a-z0-9.+-]+;base64,/i,'');
    if(image.url||!data||!/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType)||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)||Buffer.byteLength(data,'base64')>20*1024*1024)throw Error('pi_image_source_invalid');
    return {type:'image',data,mimeType:image.mimeType};
  });
}
