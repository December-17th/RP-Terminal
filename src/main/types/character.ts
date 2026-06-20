export interface RPTerminalCard {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: {
    name: string;
    description: string;
    personality: string;
    first_mes: string;
    mes_example: string;
    scenario: string;
    creator_notes: string;
    system_prompt: string;
    post_history_instructions: string;
    alternate_greetings: string[];
    tags: string[];
    creator: string;
    character_version: string;
    extensions: {
      rp_terminal?: {
        ui_layout?: any;
        css?: string;
        theme?: any;
        state_schema?: Record<string, any>;
        scripts?: Array<{ name: string; code: string }>;
        game_rules?: any;
        assets?: Record<string, string>;
      };
      [key: string]: unknown;
    };
  };
}
