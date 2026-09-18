export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      table_reviews: {
        Row: {
          id: string
          table_id: string
          reviewer_id: string
          status: string
          reviewed_title_id: string
          corrected_cells: Json
          updated_at: string
          completed_at: string | null
        }
        Insert: {
          id?: string
          table_id: string
          reviewer_id: string
          status?: string
          reviewed_title_id?: string
          corrected_cells?: Json
          updated_at?: string
          completed_at?: string | null
        }
        Update: {
          id?: string
          table_id?: string
          reviewer_id?: string
          status?: string
          reviewed_title_id?: string
          corrected_cells?: Json
          updated_at?: string
          completed_at?: string | null
        }
        Relationships: []
      }
      qa_reviews: {
        Row: {
          logic_confirmed: boolean
          id: string
          qa_pair_id: string
          reviewer_id: string
          status: string
          reviewed_question_id: string
          reviewed_answer_id: string
          updated_at: string
          completed_at: string | null
        }
        Insert: {
          logic_confirmed?: boolean
          id?: string
          qa_pair_id: string
          reviewer_id: string
          status?: string
          reviewed_question_id?: string
          reviewed_answer_id?: string
          updated_at?: string
          completed_at?: string | null
        }
        Update: {
          logic_confirmed?: boolean
          id?: string
          qa_pair_id?: string
          reviewer_id?: string
          status?: string
          reviewed_question_id?: string
          reviewed_answer_id?: string
          updated_at?: string
          completed_at?: string | null
        }
        Relationships: []
      }
      user_work_log: {
        Row: {
          id: number
          actor_id: string | null
          actor_role: string
          item_type: string
          table_id: string | null
          qa_pair_id: string | null
          cell_id: string | null
          source_table_id: string | null
          source_question_id: string | null
          action: string
          before_value: Json | null
          after_value: Json | null
          occurred_at: string
        }
        Insert: {
          actor_id?: string | null
          actor_role: string
          item_type: string
          table_id?: string | null
          qa_pair_id?: string | null
          cell_id?: string | null
          source_table_id?: string | null
          source_question_id?: string | null
          action: string
          before_value?: Json | null
          after_value?: Json | null
          occurred_at?: string
        }
        Update: {
          actor_id?: string | null
          actor_role?: string
          item_type?: string
          table_id?: string | null
          qa_pair_id?: string | null
          cell_id?: string | null
          source_table_id?: string | null
          source_question_id?: string | null
          action?: string
          before_value?: Json | null
          after_value?: Json | null
          occurred_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string
          id: string
          status: string
        }
        Insert: {
          created_at?: string
          email?: string
          full_name?: string
          id: string
          status?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          status?: string
        }
        Relationships: []
      }
      qa_pairs: {
        Row: {
          original_question_id: string | null
          original_qa: Json | null
          annotated_qa: Json | null
          validated_qa: Json | null
          dataset_split: string | null
          annotate_flag: number
          annotator_id: string | null
          validator_id: string | null
          answer_en: string
          answer_id: string | null
          id: string
          position: number
          question_en: string
          question_id: string | null
          status: string
          table_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          original_question_id?: string | null
          original_qa?: Json | null
          annotated_qa?: Json | null
          validated_qa?: Json | null
          dataset_split?: string | null
          annotate_flag?: number
          annotator_id?: string | null
          validator_id?: string | null
          answer_en: string
          answer_id?: string | null
          id?: string
          position?: number
          question_en: string
          question_id?: string | null
          status?: string
          table_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          original_question_id?: string | null
          original_qa?: Json | null
          annotated_qa?: Json | null
          validated_qa?: Json | null
          dataset_split?: string | null
          annotate_flag?: number
          annotator_id?: string | null
          validator_id?: string | null
          answer_en?: string
          answer_id?: string | null
          id?: string
          position?: number
          question_en?: string
          question_id?: string | null
          status?: string
          table_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "qa_pairs_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "tqa_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      table_cells: {
        Row: {
          row_index: number | null
          column_index: number | null
          id: string
          kind: string
          position: number
          source_text: string
          status: string
          table_id: string
          target_text: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          row_index?: number | null
          column_index?: number | null
          id?: string
          kind?: string
          position?: number
          source_text: string
          status?: string
          table_id: string
          target_text?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          row_index?: number | null
          column_index?: number | null
          id?: string
          kind?: string
          position?: number
          source_text?: string
          status?: string
          table_id?: string
          target_text?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "table_cells_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "tqa_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      tqa_tables: {
        Row: {
          original_table_id: string | null
          original_table: Json | null
          annotated_table: Json | null
          validated_table: Json | null
          annotate_flag: number
          annotator_id: string | null
          validator_id: string | null
          assigned_to: string | null
          code: string
          created_at: string
          id: string
          title_en: string
          title_id: string | null
        }
        Insert: {
          original_table_id?: string | null
          original_table?: Json | null
          annotated_table?: Json | null
          validated_table?: Json | null
          annotate_flag?: number
          annotator_id?: string | null
          validator_id?: string | null
          assigned_to?: string | null
          code: string
          created_at?: string
          id?: string
          title_en: string
          title_id?: string | null
        }
        Update: {
          original_table_id?: string | null
          original_table?: Json | null
          annotated_table?: Json | null
          validated_table?: Json | null
          annotate_flag?: number
          annotator_id?: string | null
          validator_id?: string | null
          assigned_to?: string | null
          code?: string
          created_at?: string
          id?: string
          title_en?: string
          title_id?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_set_user_role: {
        Args: { _user_id: string; _role?: Database["public"]["Enums"]["app_role"] | null }
        Returns: undefined
      }
      admin_set_user_roles: {
        Args: { _user_id: string; _roles: Database["public"]["Enums"]["app_role"][] }
        Returns: undefined
      }
      admin_bulk_assign_work: {
        Args: { _kind: string; _source_ids: string[]; _annotator_id?: string | null; _validator_id?: string | null; _change_annotator?: boolean; _change_validator?: boolean }
        Returns: number
      }
      admin_assign_work: {
        Args: { _kind: string; _source_id: string; _annotator_id?: string | null; _validator_id?: string | null }
        Returns: undefined
      }
      assignment_queue: {
        Args: { _kind: string; _search?: string; _limit?: number; _offset?: number }
        Returns: {
          item_id: string
          source_id: string | null
          table_code: string
          source_text: string
          annotate_flag: number
          annotator_id: string | null
          validator_id: string | null
          total_count: number
        }[]
      }
      hitab_export_page: {
        Args: { _kind: string; _stage?: string; _sample_only?: boolean; _limit?: number; _offset?: number }
        Returns: {
          source_id: string
          parent_source_id: string | null
          dataset_split: string | null
          annotate_flag: number
          work_status: string
          payload: Json
          total_count: number
        }[]
      }
      hitab_export_summary: {
        Args: { _sample_only?: boolean }
        Returns: {
          tables_current: number
          qa_current: number
          tables_final: number
          qa_final: number
          tables_missing_source: number
          qa_missing_source: number
          qa_waiting_for_table_final: number
        }[]
      }
      hitab_save_table_translation: {
        Args: { _table_id: string; _title: string; _cells: Json }
        Returns: undefined
      }
      hitab_progress: {
        Args: Record<PropertyKey, never>
        Returns: { tables_total: number; titles_done: number; cells_total: number; cells_done: number; qa_total: number; qa_done: number }[]
      }
      hitab_user_contributions: {
        Args: Record<PropertyKey, never>
        Returns: { user_id: string; full_name: string | null; email: string | null; entry_count: number }[]
      }
      hitab_open_work: {
        Args: { _kind: string; _id: string }
        Returns: undefined
      }
      hitab_set_sampling: {
        Args: { _kind: string; _source_id: string; _flag: number }
        Returns: undefined
      }
      review_queue: {
        Args: { _kind: string; _search?: string; _status?: string; _limit?: number; _offset?: number }
        Returns: {
          item_id: string
          table_code: string
          source_text: string
          translated_text: string | null
          is_ready: boolean
          review_status: string
          reviewer_id: string | null
          total_count: number
        }[]
      }
      review_queue_counts: {
        Args: { _kind: string; _search?: string }
        Returns: { total: number; belum: number; sedang: number; selesai: number }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "validator" | "anotator"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "validator", "anotator"],
    },
  },
} as const
