################################################################################
# ALB — Application Load Balancer
################################################################################

resource "aws_lb" "main" {
  name               = "${var.prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids

  tags = {
    Name        = "${var.prefix}-alb"
    Environment = var.environment
  }
}

################################################################################
# Target Groups
################################################################################

locals {
  target_groups = {
    backend = {
      port              = 8000
      health_check_path = "/health"
    }
    consumer = {
      port              = 3000
      health_check_path = "/health"
    }
    studio = {
      port              = 3000
      health_check_path = "/health"
    }
    admin = {
      port              = 3000
      health_check_path = "/health"
    }
    ticket-gw = {
      port              = 8030
      health_check_path = "/health"
    }
    realtime-hub = {
      port              = 8031
      health_check_path = "/health"
    }
  }
}

resource "aws_lb_target_group" "this" {
  for_each = local.target_groups

  name        = "${var.prefix}-${each.key}-tg"
  port        = each.value.port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = each.value.health_check_path
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name        = "${var.prefix}-${each.key}-tg"
    Environment = var.environment
  }
}

################################################################################
# HTTP Listener — Redirect to HTTPS
################################################################################

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

################################################################################
# HTTPS Listener — Default: backend
################################################################################

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["consumer"].arn
  }
}

################################################################################
# Path-based Routing Rules
################################################################################

# Priority 10: Purchase endpoints → ticket-gw
resource "aws_lb_listener_rule" "ticket_gw_purchase" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["ticket-gw"].arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/*/purchase", "/api/v1/*/tiers/*/purchase"]
    }
  }
}

# Priority 20: Queue endpoints → ticket-gw
resource "aws_lb_listener_rule" "ticket_gw_queue" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["ticket-gw"].arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/*/queue/*"]
    }
  }
}

# Priority 30: Seats endpoints → ticket-gw
resource "aws_lb_listener_rule" "ticket_gw_seats" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 30

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["ticket-gw"].arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/*/seats/*"]
    }
  }
}

# Priority 40: Cart endpoints → ticket-gw
resource "aws_lb_listener_rule" "ticket_gw_cart" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 40

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["ticket-gw"].arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/cart/*"]
    }
  }
}

# Priority 50: Waiting room → ticket-gw
resource "aws_lb_listener_rule" "ticket_gw_waiting_room" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 50

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["ticket-gw"].arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/waiting-room/*"]
    }
  }
}

# Priority 60: WebSocket → realtime-hub (sticky sessions)
resource "aws_lb_listener_rule" "realtime_hub_ws" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 60

  action {
    type = "forward"

    forward {
      target_group {
        arn = aws_lb_target_group.this["realtime-hub"].arn
      }

      stickiness {
        enabled  = true
        duration = 3600
      }
    }
  }

  condition {
    path_pattern {
      values = ["/ws/*"]
    }
  }
}

# Priority 100: Host studio* → studio
resource "aws_lb_listener_rule" "studio_host" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["studio"].arn
  }

  condition {
    host_header {
      values = ["studio*"]
    }
  }
}

# Priority 110: Host admin* → admin
resource "aws_lb_listener_rule" "admin_host" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 110

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["admin"].arn
  }

  condition {
    host_header {
      values = ["admin*"]
    }
  }
}

# Priority 200: /api/* catch-all → backend
resource "aws_lb_listener_rule" "backend_api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 200

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["backend"].arn
  }

  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }
}
