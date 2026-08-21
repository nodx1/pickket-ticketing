ALTER TABLE events ADD COLUMN IF NOT EXISTS sale_channels TEXT[] NOT NULL DEFAULT '{self}';
COMMENT ON COLUMN events.sale_channels IS '판매 채널: self=자체페이지, marketplace=피켓마켓';
