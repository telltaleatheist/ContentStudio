#=========================================================================#
# contentstudio.owenmorgan.com (HTTP): ACME and the redirect to HTTPS.    #
# Source: ContentStudio repo, server/visibility-scheduler/ops/.           #
# ACME is handled by Hestia's injected nginx.conf_letsencrypt snippet;    #
# do NOT add a ^~ /.well-known location here (headscale.tpl's note).      #
#=========================================================================#

server {
	listen      %ip%:%proxy_port%;
	server_name %domain_idn% %alias_idn%;
	access_log  /var/log/%web_system%/domains/%domain%.log combined;
	error_log   /var/log/%web_system%/domains/%domain%.error.log error;

	include %home%/%user%/conf/web/%domain%/nginx.forcessl.conf*;

	location / {
		limit_req zone=contentstudio burst=20 nodelay;
		limit_req_status 429;
		proxy_pass http://127.0.0.1:8430;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
	}

	include %home%/%user%/conf/web/%domain%/nginx.conf_*;
}
