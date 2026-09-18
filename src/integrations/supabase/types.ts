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
          assigned_to: string | null
          code: string
          created_at: string
          id: string
          title_en: string
          title_id: string | null
        }
        Insert: {
          assigned_to?: string | null
          code: string
          created_at?: string
          id?: string
          title_en: string
          title_id?: string | null
        }
        Update: {
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
