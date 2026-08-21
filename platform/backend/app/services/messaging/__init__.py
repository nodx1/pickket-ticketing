"""조직자 메시징 dispatch 서브시스템 (v2, 레벨2 영역C).

go organizer/src/lib/notification 의 컴플라이언스 게이트 + 단일 발송(dispatchOne) 을 v2 로
포팅. 실제 provider 발송(NCP Outbound Mailer / SENS SMS·알림톡)은 W5-PROVIDER 로 실배선됨
(`app/services/messaging/providers`). 설정이 갖춰지면 NcpProviderSender, 미설정이면
NotImplementedProviderSender 폴백으로 **명확히 실패**한다(조용한 성공 위장 금지).
"""
