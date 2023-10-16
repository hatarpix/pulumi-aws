import pulumi
from pulumi_aws import iam, s3, ec2, lb, route53

def main():
  
  bucket = s3.Bucket('my-bucket')

  # Create a VPC
  vpc = ec2.Vpc("work-vpc", 
                cidr_block="10.92.0.0/16",
                tags={"Name":"vpc-dev-work"})
  # Create an internet gateway
  ig = ec2.InternetGateway("ig", vpc_id=vpc.id)
  # Create subnets in the specified availability zones
  subnet_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
  subnets = {}
  for i, subnet_zone in enumerate(subnet_zones):
      subnet = ec2.Subnet(f"subnet-{i}", vpc_id=vpc.id, cidr_block=f"10.92.{i}.0/24", 
                          availability_zone=subnet_zone, map_public_ip_on_launch = True,
                          tags={"Name":f"subnet-{subnet_zone}"})
      rtable = ec2.RouteTable(f"rtable-{i}", vpc_id=vpc.id)
      ec2.RouteTableAssociation(f"rtable_assoc-{i}", subnet_id=subnet.id, route_table_id=rtable.id)
      ec2.Route(f"route-{i}", route_table_id=rtable.id, destination_cidr_block="0.0.0.0/0", gateway_id=ig.id)
      subnets[i] = subnet

  # Create an ALL SSH security group
  ssh_sg = ec2.SecurityGroup("ALL-ssh", 
                             vpc_id=vpc.id,
                             tags={"Name":"ALL-ssh"},
                             ingress=[{'protocol': 'tcp', 'from_port': 22, 'to_port': 22, 'cidr_blocks': ['0.0.0.0/0']}],
                             egress=[{"protocol": "-1", "from_port": 0, "to_port": 0, "cidr_blocks": ["0.0.0.0/0"]}]   # Allow all outbound traffic
                             )

  # Create an ALL-80-443 security group                      
  http_https_sg = ec2.SecurityGroup("ALL-http-https", 
                                    vpc_id=vpc.id,
                                    tags={"Name":"ALL-http-https"},
                                    ingress=[
                                        {'protocol': 'tcp', 'from_port': 80, 'to_port': 80, 'cidr_blocks': ['0.0.0.0/0']},
                                        {'protocol': 'tcp', 'from_port': 443, 'to_port': 443, 'cidr_blocks': ['0.0.0.0/0']}
                                    ],
                                    egress=[{"protocol": "-1", "from_port": 0, "to_port": 0, "cidr_blocks": ["0.0.0.0/0"]}]  # Allow all outbound traffic
                                    )                                            

  k8s_sg = ec2.SecurityGroup("ALL-K8S-api", 
                             vpc_id=vpc.id,
                             tags={"Name":"ALL-ssh"},
                             ingress=[{'protocol': 'tcp', 'from_port': 16443, 'to_port': 16443, 'cidr_blocks': ['0.0.0.0/0']}],
                             egress=[{"protocol": "-1", "from_port": 0, "to_port": 0, "cidr_blocks": ["0.0.0.0/0"]}]   # Allow all outbound traffic
                             )

##################################################################
  ami = ec2.get_ami(
	most_recent="true",
	owners=["099720109477"],
	filters=[{"name": "name", "values": ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]}]
  )
  userData = """#!/bin/bash
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
mkdir -p /var/snap/microk8s/common/
cat <<EOT >> /var/snap/microk8s/common/.microk8s.yaml 
---
version: 0.1.0
addons:
  - name: dns
  - name: rbac
  - name: ingress
  - name: cert-manager
extraSANs:
  - k8s.${dnsZoneName}
EOT
snap install microk8s --classic --channel=1.28
snap install aws-cli --classic
usermod -a -G microk8s ubuntu
chown -f -R ubuntu /home/ubuntu/.kube
sed -i 's/--cluster-dns=10.152.183.10/--cluster-dns=10.152.183.10,1.1.1.1,8.8.8.8/g' /var/snap/microk8s/current/args/kubelet
"""
  keyPair = ec2.KeyPair("adminaws-keypair",
    public_key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINWO9EKfPEQCbFV9VGl/GCp1cRfEugz/Yr36ch6yKd4p admin",
  )
##################################################################
# Profile
##################################################################
  # creating a new IAM role for EC2
  ec2_role = iam.Role('K8S-ec2-role',
    assume_role_policy="""{
    "Version": "2012-10-17",
    "Statement": [
        {
        "Action": "sts:AssumeRole",
        "Principal": {
            "Service": "ec2.amazonaws.com"
        },
        "Effect": "Allow",
        "Sid": ""
        }
    ]
    }"""
  )

# Assigning ECR policy to the EC2 role
  ecr_policy = iam.Policy('ECRPolicy',
    policy=iam.get_policy_document(
        statements=[
            iam.GetPolicyDocumentStatementArgs(
                actions=['ecr:*'],
                resources=['*']
            )
        ]
    ).json,
  )

  ecr_policy_attachment = iam.RolePolicyAttachment('ecrPolicyAttachment',
    role=ec2_role.name,
    policy_arn=ecr_policy.arn
  )

# Assigning S3 full access policy to the EC2 role
  s3_policy = iam.Policy('s3Policy',
    policy=iam.get_policy_document(
        statements=[
            iam.GetPolicyDocumentStatementArgs(
                actions=['s3:*'],
                resources=['*']
            )
        ]
    ).json,
  )

  s3_policy_attachment = iam.RolePolicyAttachment('s3PolicyAttachment',
    role=ec2_role.name,
    policy_arn=s3_policy.arn
  )

  ec2_instance_profile = iam.InstanceProfile("ec2-Profile-k8s",
    role=ec2_role.name
  )
#########################################################################
  instances = {}
  for i,subnet in subnets.items():
    instance = ec2.Instance(f'k8-instance-{i}',
                        instance_type='t2.micro',
                        ami=ami.id,
                        iam_instance_profile=ec2_instance_profile.name,
                        vpc_security_group_ids=[ssh_sg.id, 
                                                http_https_sg.id,
                                                k8s_sg.id],
                        subnet_id=subnet.id,
                        tags={"Name":f"k8s-{i}", "env":"dev"},
                        root_block_device=ec2.InstanceRootBlockDeviceArgs(
                                                        volume_type='gp3',
                                                        volume_size=30
                                                    ),
                        user_data=userData,
                        key_name = keyPair
                        )
    instances[i] = instance
#########################################################################
# NLB
#########################################################################

  # Create the load balancer
  nlb = lb.LoadBalancer('k8s-nlb',
    load_balancer_type="network",
    subnets=[sub.id for sub in subnets.values()],
    internal=False,
    tags={"Name":f"k8s-nlb", "env":"dev"},

    )
  
  listeners = [80, 443, 16443]
  for listener in listeners:
    target_group = lb.TargetGroup(f"targetgroup-{listener}",
        port=listener,
        protocol="TCP",
        vpc_id=vpc.id,
        target_type="instance",
        health_check = {
            'interval': 30,
            'protocol': 'TCP',
            'port': listener
        },
        tags={"Name":f"targetgroup-{listener}", "env":"dev"},
   )
    for i,instance in instances.items():
        target_group_attachment = lb.TargetGroupAttachment(f"target-{listener}-{i}",
            target_group_arn=target_group.arn,
            target_id=instance.id
        )
    listener = lb.Listener(f"listener-{listener}",
                   load_balancer_arn = nlb.arn,
                   port = listener,
                   protocol = "TCP",
                   default_actions=[lb.ListenerDefaultActionArgs(
                        type="forward",
                        target_group_arn=target_group.arn
                    )]
                   )

  my_zone = route53.get_zone(name="aws.domain.com")
  cname_record = route53.Record('k8s-dev-nlb',
                              zone_id=my_zone.zone_id,
                              name="k8s-dev",
                              type="CNAME",
                              ttl=300,
                              records=[nlb.dns_name])
  for i,instance in instances.items():
    instance_record = route53.Record(f"k8s-dev-{i}",
                              zone_id=my_zone.zone_id,
                              name=f"k8s-dev-{i}",
                              type="A",
                              ttl=300,
                              records=[instance.public_ip],
                              allow_overwrite=True
                              )




  # Exporting the IDs of created resources
  pulumi.export("vpc ID", vpc.id)
  pulumi.export("SSH Security Group id", ssh_sg.id)
  pulumi.export("HTTP/HTTPS Security Group id", http_https_sg.id)
  pulumi.export('bucket_name', bucket.id)
  pulumi.export("Internet Gateway id", ig.id)

main()
