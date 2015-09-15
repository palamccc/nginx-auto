FROM node:4.0.0-slim

RUN apt-key adv --keyserver hkp://pgp.mit.edu:80 --recv-keys 573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62
RUN echo "deb http://nginx.org/packages/mainline/debian/ jessie nginx" >> /etc/apt/sources.list

ENV NGINX_VERSION 1.9.4-1~jessie

RUN apt-get update && \
    apt-get install -y ca-certificates supervisor nginx=${NGINX_VERSION} && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
RUN sed -i 's/^http {/&\n    server_names_hash_bucket_size 128;/g' /etc/nginx/nginx.conf

COPY package.json /usr/src/app/package.json
WORKDIR /usr/src/app
ENV NODE_ENV production
RUN npm prune --quiet --production && npm install --quiet --production
EXPOSE 80 443
VOLUME ["/usr/src/app/certs"]
COPY . /usr/src/app
CMD ["/usr/bin/supervisord", "-c", "supervisord.conf"]