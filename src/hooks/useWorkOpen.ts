import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

/** Records deliberate entry into an eligible workspace, once per mount/item. */
export function useWorkOpen(kind: "table" | "qa" | "table_review" | "qa_review", id: string | undefined, enabled: boolean) {
  const opened=useRef<string | null>(null);
  useEffect(()=>{
    if (!enabled || !id) return;
    const key=`${kind}:${id}`;
    if (opened.current===key) return;
    opened.current=key;
    void supabase.rpc("hitab_open_work", {_kind:kind,_id:id}).then(({error})=>{
      if (error) {
        opened.current=null;
        console.warn("Could not record work opening:",error.message);
      }
    });
  },[kind,id,enabled]);
}
